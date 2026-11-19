import os
import csv
import io
import json
import uuid
from datetime import datetime
import requests
import eventlet
from flask import Flask, render_template, request, jsonify, url_for, Response
from flask_socketio import SocketIO, emit, join_room, leave_room
from flask_sqlalchemy import SQLAlchemy
from werkzeug.utils import secure_filename

app = Flask(__name__)
app.config["SECRET_KEY"] = os.environ.get("SECRET_KEY", "vortex-ghost-messenger-secret-key")
app.config["SQLALCHEMY_DATABASE_URI"] = os.environ.get("DATABASE_URL", "sqlite:///messenger.db")
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
app.config["UPLOAD_FOLDER"] = os.path.join("static", "uploads")
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024

ENV_OWNER_CALLSIGN = os.environ.get("OWNER_CALLSIGN", "").strip()

ALLOWED_IMAGE_EXT = {"png", "jpg", "jpeg", "gif", "webp"}
ALLOWED_AUDIO_EXT = {"webm", "ogg", "mp4", "m4a", "wav", "mp3"}

DEFAULT_NWS_STATES = ["AL", "GA", "IN", "WI", "OH", "TN", "MS", "FL", "OK"]
NWS_TARGET_EVENTS = {
    "Tornado Warning",
    "Tornado Watch",
    "Severe Thunderstorm Warning",
    "Severe Thunderstorm Watch",
    "Flash Flood Warning",
    "Flash Flood Emergency",
    "Extreme Wind Warning",
}
NWS_HEADERS = {
    "User-Agent": "(VortexGhostMessenger/3.3, ops@vortexghost.site)",
    "Accept": "application/geo+json",
}

db = SQLAlchemy(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode="eventlet")


class UserProfile(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    avatar_url = db.Column(db.String(255), nullable=True)
    updated_at = db.Column(db.DateTime, default=datetime.utcnow)


class AdminUser(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(80), unique=True, nullable=False)
    is_owner = db.Column(db.Boolean, default=False)
    granted_by = db.Column(db.String(80), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class Thread(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(100), nullable=False)
    is_group = db.Column(db.Boolean, default=True)
    is_locked = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class Message(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    thread_id = db.Column(db.Integer, db.ForeignKey("thread.id"), nullable=False)
    sender = db.Column(db.String(80), nullable=False)
    body = db.Column(db.Text, nullable=False)
    msg_type = db.Column(db.String(20), default="text")
    media_url = db.Column(db.String(255), nullable=True)
    reply_to_id = db.Column(db.Integer, nullable=True)
    reply_preview = db.Column(db.String(180), nullable=True)
    is_pinned = db.Column(db.Boolean, default=False)
    edited_at = db.Column(db.String(32), nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class Reaction(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    message_id = db.Column(db.Integer, db.ForeignKey("message.id"), nullable=False)
    username = db.Column(db.String(80), nullable=False)
    emoji = db.Column(db.String(16), nullable=False)


class ReadReceipt(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    thread_id = db.Column(db.Integer, nullable=False)
    username = db.Column(db.String(80), nullable=False)
    last_message_id = db.Column(db.Integer, default=0)


class SeenAlert(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    alert_id = db.Column(db.String(180), unique=True, nullable=False)
    event = db.Column(db.String(100), nullable=False)
    area = db.Column(db.String(255), nullable=True)
    headline = db.Column(db.String(255), nullable=True)
    expires = db.Column(db.String(40), nullable=True)
    geometry_json = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


class FieldReport(db.Model):
    id = db.Column(db.Integer, primary_key=True)
    thread_id = db.Column(db.Integer, nullable=False)
    spotter = db.Column(db.String(80), nullable=False)
    phenomenon = db.Column(db.String(80), nullable=False)
    magnitude = db.Column(db.String(80), nullable=True)
    location_text = db.Column(db.String(160), nullable=False)
    gps_coords = db.Column(db.String(64), nullable=True)
    lat = db.Column(db.Float, nullable=True)
    lon = db.Column(db.Float, nullable=True)
    notes = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)


online_users = {}
poller_started = False


def allowed_ext(filename, allowed_set):
    return "." in filename and filename.rsplit(".", 1)[1].lower() in allowed_set


def parse_lat_lon(coord_str):
    if not coord_str or "," not in coord_str:
        return None, None
    try:
        parts = [p.strip() for p in coord_str.split(",")]
        return float(parts[0]), float(parts[1])
    except Exception:
        return None, None


def get_avatar_url(username):
    clean = (username or "").strip()
    if not clean:
        return None
    prof = UserProfile.query.filter(db.func.lower(UserProfile.username) == clean.lower()).first()
    return prof.avatar_url if prof else None


def get_all_avatars_map():
    rows = UserProfile.query.filter(UserProfile.avatar_url.isnot(None)).all()
    return {r.username.lower(): r.avatar_url for r in rows}


def get_role_flags(username):
    clean = (username or "").strip()
    if not clean:
        return False, False

    if ENV_OWNER_CALLSIGN:
        is_match = clean.lower() == ENV_OWNER_CALLSIGN.lower()
        rec = AdminUser.query.filter(db.func.lower(AdminUser.username) == clean.lower()).first()
        if is_match:
            if not rec:
                rec = AdminUser(username=clean, is_owner=True, granted_by="ENV_OWNER")
                db.session.add(rec)
                db.session.commit()
            elif not rec.is_owner:
                rec.is_owner = True
                db.session.commit()
            return True, True
        else:
            if rec and rec.is_owner:
                rec.is_owner = False
                db.session.commit()
            return bool(rec), False

    if AdminUser.query.filter_by(is_owner=True).count() == 0:
        rec = AdminUser(username=clean, is_owner=True, granted_by="FIRST_CLAIM")
        db.session.add(rec)
        db.session.commit()
        return True, True

    rec = AdminUser.query.filter(db.func.lower(AdminUser.username) == clean.lower()).first()
    if rec:
        return True, bool(rec.is_owner)
    return False, False


def serialize_reactions(message_id):
    rows = Reaction.query.filter_by(message_id=message_id).all()
    grouped = {}
    for r in rows:
        grouped.setdefault(r.emoji, []).append(r.username)
    return [{"emoji": emoji, "users": users, "count": len(users)} for emoji, users in grouped.items()]


def format_thread_preview(msg):
    if not msg:
        return "No messages yet"
    if msg.msg_type == "image":
        return f"{msg.sender}: [Photo/Radar]"
    if msg.msg_type == "audio":
        return f"{msg.sender}: 🎙️ Voice Memo"
    if msg.msg_type == "location":
        return f"{msg.sender}: [GPS Pin]"
    if msg.msg_type == "report":
        return f"📋 {msg.sender}: Field Report"
    if msg.msg_type == "nws":
        return f"🌪️ {msg.body[:40]}"
    return f"{msg.sender}: {msg.body[:36]}"


def serialize_message(m, avatars_map=None):
    amap = avatars_map if avatars_map is not None else get_all_avatars_map()
    return {
        "id": m.id,
        "thread_id": m.thread_id,
        "sender": m.sender,
        "sender_avatar": amap.get((m.sender or "").lower()),
        "body": m.body,
        "msg_type": m.msg_type,
        "media_url": m.media_url,
        "reply_to_id": m.reply_to_id,
        "reply_preview": m.reply_preview,
        "is_pinned": bool(m.is_pinned),
        "edited_at": m.edited_at,
        "timestamp": m.created_at.strftime("%I:%M %p"),
        "created_at_iso": m.created_at.isoformat() + "Z",
        "reactions": serialize_reactions(m.id),
    }


def broadcast_presence():
    now = datetime.utcnow()
    with app.app_context():
        amap = get_all_avatars_map()
    by_user = {}
    for u in online_users.values():
        last_ci = u.get("last_checkin") or now
        mins_ago = int((now - last_ci).total_seconds() // 60)
        overdue = bool(u.get("escalated")) or (
            u.get("status") in {"On Storm", "En Route"} and mins_ago >= 20
        )
        by_user[u["username"]] = {
            "username": u["username"],
            "avatar_url": amap.get(u["username"].lower()),
            "status": u.get("status") or "En Route",
            "is_admin": bool(u.get("is_admin")),
            "is_owner": bool(u.get("is_owner")),
            "lat": u.get("lat"),
            "lon": u.get("lon"),
            "last_checkin": last_ci.strftime("%I:%M %p"),
            "last_checkin_iso": last_ci.isoformat() + "Z",
            "mins_since_checkin": mins_ago,
            "overdue": overdue,
        }
    roster = [by_user[k] for k in sorted(by_user.keys())]
    socketio.emit("presence_update", {"online_users": roster})


def init_seed_data():
    os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)
    with app.app_context():
        db.create_all()
        if Thread.query.count() == 0:
            db.session.add_all([
                Thread(name="Team Convoy (Main)", is_group=True),
                Thread(name="Radar & Spotter Ops", is_group=True),
                Thread(name="Severe Alerts & Pins", is_group=True),
            ])
            db.session.commit()


init_seed_data()


def poll_nws_alerts_once(states=None):
    target_states = states or DEFAULT_NWS_STATES
    area_param = ",".join(target_states)
    url = f"https://api.weather.gov/alerts/active?area={area_param}"
    inserted = 0

    try:
        resp = requests.get(url, headers=NWS_HEADERS, timeout=12)
        if resp.status_code != 200:
            return 0
        features = resp.json().get("features", [])
    except Exception:
        return 0

    with app.app_context():
        alerts_thread = Thread.query.filter_by(name="Severe Alerts & Pins").first()
        main_thread = Thread.query.filter_by(name="Team Convoy (Main)").first()
        alerts_tid = alerts_thread.id if alerts_thread else 3
        main_tid = main_thread.id if main_thread else 1

        for feat in features:
            props = feat.get("properties") or {}
            alert_id = props.get("id") or feat.get("id")
            event = (props.get("event") or "").strip()
            if not alert_id or event not in NWS_TARGET_EVENTS:
                continue

            if SeenAlert.query.filter_by(alert_id=alert_id).first():
                continue

            area_desc = (props.get("areaDesc") or "Unknown Area")[:240]
            headline = (props.get("headline") or event).strip()[:240]
            expires = (props.get("expires") or "")[:16].replace("T", " ")
            geom = feat.get("geometry")
            geom_str = json.dumps(geom) if geom else None

            db.session.add(
                SeenAlert(
                    alert_id=alert_id,
                    event=event,
                    area=area_desc,
                    headline=headline,
                    expires=expires,
                    geometry_json=geom_str,
                )
            )

            body_text = (
                f"🚨 NWS {event.upper()}\n"
                f"Area: {area_desc}\n"
                f"{headline}"
                + (f"\nExpires: {expires} UTC" if expires else "")
            )

            msg_alerts = Message(
                thread_id=alerts_tid,
                sender="NWS Auto-Bot",
                body=body_text,
                msg_type="nws",
            )
            db.session.add(msg_alerts)
            db.session.commit()
            payload_alerts = serialize_message(msg_alerts)
            socketio.emit("new_message", payload_alerts, to=f"thread_{alerts_tid}")
            socketio.emit("thread_preview_update", payload_alerts)
            inserted += 1

            if "Tornado Warning" in event or "Extreme Wind" in event:
                msg_main = Message(
                    thread_id=main_tid,
                    sender="NWS Auto-Bot",
                    body=body_text,
                    msg_type="nws",
                )
                db.session.add(msg_main)
                db.session.commit()
                payload_main = serialize_message(msg_main)
                socketio.emit("new_message", payload_main, to=f"thread_{main_tid}")
                socketio.emit("thread_preview_update", payload_main)

    return inserted


def background_ops_loop():
    while True:
        eventlet.sleep(90)
        try:
            poll_nws_alerts_once()
        except Exception:
            pass

        now = datetime.utcnow()
        escalated_names = []
        for sid, info in list(online_users.items()):
            last_ci = info.get("last_checkin") or now
            mins = (now - last_ci).total_seconds() / 60.0
            if info.get("status") in {"On Storm", "En Route"} and mins >= 20 and not info.get("escalated"):
                info["escalated"] = True
                escalated_names.append((info["username"], info["status"], int(mins)))

        if escalated_names:
            broadcast_presence()
            with app.app_context():
                for uname, st, mins in escalated_names:
                    warn_msg = Message(
                        thread_id=1,
                        sender="Safety Watchdog",
                        body=f"⚠️ ESCALATION: {uname} ({st}) has not checked in for {mins} mins. Please confirm status!",
                        msg_type="alert",
                    )
                    db.session.add(warn_msg)
                    db.session.commit()
                    payload = serialize_message(warn_msg)
                    socketio.emit("new_message", payload, to="thread_1")
                    socketio.emit("thread_preview_update", payload)


def start_background_workers():
    global poller_started
    if not poller_started:
        poller_started = True
        eventlet.spawn(background_ops_loop)


@app.route("/")
def index():
    start_background_workers()
    return render_template("index.html")


@app.route("/api/whoami")
def whoami():
    user = (request.args.get("username") or "").strip()
    is_admin, is_owner = get_role_flags(user)
    avatar_url = get_avatar_url(user)
    return jsonify({
        "username": user,
        "is_admin": is_admin,
        "is_owner": is_owner,
        "avatar_url": avatar_url,
    })


@app.route("/api/avatar", methods=["POST"])
def upload_avatar():
    username = (request.form.get("username") or "").strip()
    if not username:
        return jsonify({"error": "Callsign required"}), 400
    if "file" not in request.files:
        return jsonify({"error": "No image provided"}), 400
    file = request.files["file"]
    if not file or file.filename == "" or not allowed_ext(file.filename, ALLOWED_IMAGE_EXT):
        return jsonify({"error": "Invalid image format"}), 400

    ext = secure_filename(file.filename).rsplit(".", 1)[1].lower()
    unique_name = f"avatar_{uuid.uuid4().hex}.{ext}"
    save_path = os.path.join(app.config["UPLOAD_FOLDER"], unique_name)
    file.save(save_path)

    new_url = url_for("static", filename=f"uploads/{unique_name}")
    prof = UserProfile.query.filter(db.func.lower(UserProfile.username) == username.lower()).first()
    if prof:
        if prof.avatar_url and prof.avatar_url.startswith("/static/uploads/"):
            old_path = os.path.join(app.root_path, prof.avatar_url.lstrip("/"))
            if os.path.exists(old_path):
                try:
                    os.remove(old_path)
                except OSError:
                    pass
        prof.avatar_url = new_url
        prof.updated_at = datetime.utcnow()
    else:
        prof = UserProfile(username=username, avatar_url=new_url)
        db.session.add(prof)
    db.session.commit()

    socketio.emit("avatar_updated", {"username": username, "avatar_url": new_url})
    broadcast_presence()
    return jsonify({"username": username, "avatar_url": new_url})


@app.route("/api/threads")
def get_threads():
    threads = Thread.query.order_by(Thread.id.asc()).all()
    result = []
    for t in threads:
        last_msg = (
            Message.query.filter_by(thread_id=t.id)
            .order_by(Message.id.desc())
            .first()
        )
        result.append({
            "id": t.id,
            "name": t.name,
            "is_group": t.is_group,
            "is_locked": bool(t.is_locked),
            "preview": format_thread_preview(last_msg),
            "last_time": last_msg.created_at.strftime("%I:%M %p") if last_msg else "",
            "last_time_iso": (last_msg.created_at.isoformat() + "Z") if last_msg else "",
        })
    return jsonify(result)


@app.route("/api/threads", methods=["POST"])
def create_thread():
    data = request.get_json(force=True)
    name = (data.get("name") or "").strip()
    is_group = bool(data.get("is_group", True))
    if not name:
        return jsonify({"error": "Thread name required"}), 400
    t = Thread(name=name, is_group=is_group)
    db.session.add(t)
    db.session.commit()
    payload = {
        "id": t.id,
        "name": t.name,
        "is_group": t.is_group,
        "is_locked": False,
        "preview": "New thread",
        "last_time": "",
    }
    socketio.emit("thread_created", payload)
    return jsonify(payload), 201


@app.route("/api/dm", methods=["POST"])
def open_or_create_dm():
    data = request.get_json(force=True)
    user_a = (data.get("user_a") or "").strip()
    user_b = (data.get("user_b") or "").strip()
    if not user_a or not user_b or user_a == user_b:
        return jsonify({"error": "Two distinct spotters required"}), 400

    pair = sorted([user_a, user_b])
    dm_label = f"DM: {pair[0]} & {pair[1]}"
    existing = Thread.query.filter_by(name=dm_label, is_group=False).first()
    if existing:
        return jsonify({"id": existing.id, "name": existing.name, "is_group": False, "is_locked": bool(existing.is_locked), "created": False})

    t = Thread(name=dm_label, is_group=False)
    db.session.add(t)
    db.session.commit()
    payload = {"id": t.id, "name": t.name, "is_group": False, "is_locked": False, "preview": "Direct message", "last_time": ""}
    socketio.emit("thread_created", payload)
    return jsonify({**payload, "created": True}), 201


@app.route("/api/map-data")
def get_map_data():
    spotters = []
    seen_names = set()
    for u in online_users.values():
        if u.get("lat") is not None and u.get("lon") is not None and u["username"] not in seen_names:
            seen_names.add(u["username"])
            spotters.append({
                "username": u["username"],
                "status": u.get("status") or "En Route",
                "lat": u["lat"],
                "lon": u["lon"],
                "is_admin": bool(u.get("is_admin")),
            })

    reports = (
        FieldReport.query.filter(FieldReport.lat.isnot(None), FieldReport.lon.isnot(None))
        .order_by(FieldReport.id.desc())
        .limit(60)
        .all()
    )
    report_pins = [
        {
            "id": r.id,
            "spotter": r.spotter,
            "phenomenon": r.phenomenon,
            "magnitude": r.magnitude,
            "location_text": r.location_text,
            "notes": r.notes or "",
            "lat": r.lat,
            "lon": r.lon,
            "timestamp": r.created_at.strftime("%I:%M %p"),
                "created_at_iso": r.created_at.isoformat() + "Z",
        }
        for r in reports
    ]

    alerts = (
        SeenAlert.query.filter(SeenAlert.geometry_json.isnot(None))
        .order_by(SeenAlert.id.desc())
        .limit(40)
        .all()
    )
    polygons = []
    for a in alerts:
        try:
            geom = json.loads(a.geometry_json)
            if geom:
                polygons.append({
                    "id": a.id,
                    "event": a.event,
                    "area": a.area,
                    "headline": a.headline,
                    "expires": a.expires,
                    "geometry": geom,
                })
        except Exception:
            pass

    return jsonify({
        "spotters": spotters,
        "reports": report_pins,
        "polygons": polygons,
    })


@app.route("/api/nws/sync", methods=["POST"])
def trigger_nws_sync():
    data = request.get_json(silent=True) or {}
    raw_states = (data.get("states") or "").strip()
    states = [s.strip().upper() for s in raw_states.split(",") if len(s.strip()) == 2] if raw_states else DEFAULT_NWS_STATES
    count = poll_nws_alerts_once(states)
    return jsonify({"inserted": count, "states": states})


@app.route("/api/reports", methods=["POST"])
def submit_field_report():
    data = request.get_json(force=True)
    thread_id = int(data.get("thread_id", 1))
    spotter = (data.get("spotter") or "Spotter").strip()
    phenomenon = (data.get("phenomenon") or "Severe Weather").strip()
    magnitude = (data.get("magnitude") or "N/A").strip()
    location_text = (data.get("location_text") or "").strip()
    gps_coords = (data.get("gps_coords") or "").strip()
    notes = (data.get("notes") or "").strip()

    if not location_text:
        return jsonify({"error": "Location or county required"}), 400

    lat, lon = parse_lat_lon(gps_coords)
    report = FieldReport(
        thread_id=thread_id,
        spotter=spotter,
        phenomenon=phenomenon,
        magnitude=magnitude,
        location_text=location_text,
        gps_coords=gps_coords,
        lat=lat,
        lon=lon,
        notes=notes,
    )
    db.session.add(report)
    db.session.commit()

    formatted_body = (
        f"📋 FIELD REPORT #{report.id} — {phenomenon.upper()}\n"
        f"• Magnitude / Size: {magnitude}\n"
        f"• Location: {location_text}"
        + (f" ({gps_coords})" if gps_coords else "")
        + (f"\n• Notes: {notes}" if notes else "")
    )

    msg = Message(
        thread_id=thread_id,
        sender=spotter,
        body=formatted_body,
        msg_type="report",
    )
    db.session.add(msg)
    db.session.commit()

    payload = serialize_message(msg)
    socketio.emit("new_message", payload, to=f"thread_{thread_id}")
    socketio.emit("thread_preview_update", payload)
    return jsonify({"report_id": report.id, "message": payload}), 201


@app.route("/api/reports/export.csv")
def export_reports_csv():
    reports = FieldReport.query.order_by(FieldReport.id.asc()).all()
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(["Report ID", "Timestamp (UTC)", "Spotter", "Phenomenon", "Magnitude", "Location", "GPS", "Notes"])
    for r in reports:
        writer.writerow([
            r.id,
            r.created_at.strftime("%Y-%m-%d %H:%M:%S"),
            r.spotter,
            r.phenomenon,
            r.magnitude,
            r.location_text,
            r.gps_coords or "",
            r.notes or "",
        ])
    return Response(
        output.getvalue(),
        mimetype="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="vortex_field_reports.csv"'},
    )


@app.route("/api/upload", methods=["POST"])
def upload_image():
    if "file" not in request.files:
        return jsonify({"error": "No file part"}), 400
    file = request.files["file"]
    if not file or file.filename == "" or not allowed_ext(file.filename, ALLOWED_IMAGE_EXT):
        return jsonify({"error": "Invalid image file"}), 400

    ext = secure_filename(file.filename).rsplit(".", 1)[1].lower()
    unique_name = f"{uuid.uuid4().hex}.{ext}"
    save_path = os.path.join(app.config["UPLOAD_FOLDER"], unique_name)
    file.save(save_path)
    return jsonify({"url": url_for("static", filename=f"uploads/{unique_name}")})


@app.route("/api/upload-audio", methods=["POST"])
def upload_audio():
    if "file" not in request.files:
        return jsonify({"error": "No audio file"}), 400
    file = request.files["file"]
    if not file or file.filename == "":
        return jsonify({"error": "Empty audio file"}), 400

    raw_name = secure_filename(file.filename) or "ptt.webm"
    ext = raw_name.rsplit(".", 1)[1].lower() if "." in raw_name else "webm"
    if ext not in ALLOWED_AUDIO_EXT:
        ext = "webm"
    unique_name = f"ptt_{uuid.uuid4().hex}.{ext}"
    save_path = os.path.join(app.config["UPLOAD_FOLDER"], unique_name)
    file.save(save_path)
    return jsonify({"url": url_for("static", filename=f"uploads/{unique_name}")})


@app.route("/api/threads/<int:thread_id>/messages")
def get_messages(thread_id):
    thread = db.session.get(Thread, thread_id)
    amap = get_all_avatars_map()
    msgs = (
        Message.query.filter_by(thread_id=thread_id)
        .order_by(Message.id.asc())
        .limit(150)
        .all()
    )
    pinned_msg = (
        Message.query.filter_by(thread_id=thread_id, is_pinned=True)
        .order_by(Message.id.desc())
        .first()
    )
    receipts = ReadReceipt.query.filter_by(thread_id=thread_id).all()
    return jsonify({
        "is_locked": bool(thread.is_locked) if thread else False,
        "messages": [serialize_message(m, amap) for m in msgs],
        "pinned": serialize_message(pinned_msg, amap) if pinned_msg else None,
        "seen_by": [
            {"username": r.username, "last_message_id": r.last_message_id}
            for r in receipts
        ],
    })


@app.route("/api/threads/<int:thread_id>/export")
def export_thread_log(thread_id):
    thread = db.session.get(Thread, thread_id)
    if not thread:
        return jsonify({"error": "Thread not found"}), 404

    msgs = (
        Message.query.filter_by(thread_id=thread_id)
        .order_by(Message.id.asc())
        .all()
    )
    lines = [
        f"VORTEX MESSENGER SHIFT LOG — {thread.name}",
        f"Exported (UTC): {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')}",
        "=" * 54,
        "",
    ]
    for m in msgs:
        stamp = m.created_at.strftime("%Y-%m-%d %I:%M %p")
        edited = " [edited]" if m.edited_at else ""
        tag = f" [{m.msg_type.upper()}]" if m.msg_type != "text" else ""
        media = f" (Media: {m.media_url})" if m.media_url else ""
        lines.append(f"[{stamp}]{tag} {m.sender}{edited}: {m.body}{media}")

    content = "\n".join(lines) + "\n"
    safe_slug = "".join(c if c.isalnum() or c in ("-", "_") else "_" for c in thread.name.lower())
    return Response(
        content,
        mimetype="text/plain; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{safe_slug}_log.txt"'},
    )


@socketio.on("register_user")
def on_register_user(data):
    start_background_workers()
    username = (data.get("username") or "Spotter").strip()
    thread_id = int(data.get("thread_id", 1))
    status = (data.get("status") or "En Route").strip()
    is_admin, is_owner = get_role_flags(username)

    online_users[request.sid] = {
        "username": username,
        "thread_id": thread_id,
        "status": status,
        "is_admin": is_admin,
        "is_owner": is_owner,
        "lat": None,
        "lon": None,
        "last_checkin": datetime.utcnow(),
        "escalated": False,
    }
    join_room(f"thread_{thread_id}")
    emit("role_assigned", {"username": username, "is_admin": is_admin, "is_owner": is_owner})
    broadcast_presence()


@socketio.on("set_user_admin")
def on_set_user_admin(data):
    actor = online_users.get(request.sid)
    if not actor or not actor.get("is_admin"):
        emit("system_notice", {"message": "Admin privileges required."})
        return

    target_user = (data.get("target_user") or "").strip()
    make_admin = bool(data.get("make_admin", True))
    if not target_user or target_user.lower() == actor["username"].lower():
        return

    rec = AdminUser.query.filter(db.func.lower(AdminUser.username) == target_user.lower()).first()
    if rec and rec.is_owner:
        emit("system_notice", {"message": "Owner Admin status cannot be revoked."})
        return

    if make_admin:
        if not rec:
            db.session.add(AdminUser(username=target_user, is_owner=False, granted_by=actor["username"]))
            db.session.commit()
    else:
        if rec:
            db.session.delete(rec)
            db.session.commit()

    for sid, info in online_users.items():
        if info["username"].lower() == target_user.lower():
            info["is_admin"] = make_admin
            socketio.emit(
                "role_assigned",
                {"username": info["username"], "is_admin": make_admin, "is_owner": bool(info.get("is_owner"))},
                to=sid,
            )

    broadcast_presence()


@socketio.on("update_status")
def on_update_status(data):
    status = (data.get("status") or "En Route").strip()
    username = (data.get("username") or "Spotter").strip()
    entry = online_users.get(request.sid)
    if entry:
        entry["status"] = status
        entry["last_checkin"] = datetime.utcnow()
        entry["escalated"] = False
        if username:
            entry["username"] = username
    broadcast_presence()


@socketio.on("update_gps")
def on_update_gps(data):
    lat = data.get("lat")
    lon = data.get("lon")
    entry = online_users.get(request.sid)
    if entry and lat is not None and lon is not None:
        entry["lat"] = float(lat)
        entry["lon"] = float(lon)
        entry["last_checkin"] = datetime.utcnow()
        broadcast_presence()


@socketio.on("safety_checkin")
def on_safety_checkin(data):
    username = (data.get("username") or "Spotter").strip()
    thread_id = int(data.get("thread_id", 1))
    mode = (data.get("mode") or "safe").strip()
    coords = (data.get("coords") or "").strip()
    lat, lon = parse_lat_lon(coords)

    entry = online_users.get(request.sid)
    new_status = "🛡️ Sheltered / Safe" if mode == "safe" else "🚨 MAYDAY / Assist"
    if entry:
        entry["status"] = new_status
        entry["last_checkin"] = datetime.utcnow()
        entry["escalated"] = (mode == "mayday")
        if lat is not None and lon is not None:
            entry["lat"] = lat
            entry["lon"] = lon

    broadcast_presence()

    if mode == "mayday":
        body = f"🚨 MAYDAY / ASSISTANCE REQUESTED by {username}!" + (f" GPS: {coords}" if coords else "")
        msg_type = "alert"
    else:
        body = f"🛡️ SAFETY CHECK-IN: {username} confirmed SHELTERED / SAFE." + (f" ({coords})" if coords else "")
        msg_type = "text"

    msg = Message(
        thread_id=thread_id,
        sender=username,
        body=body,
        msg_type=msg_type,
    )
    db.session.add(msg)
    db.session.commit()
    payload = serialize_message(msg)
    emit("new_message", payload, to=f"thread_{thread_id}")
    emit("thread_preview_update", payload, broadcast=True)


@socketio.on("join_thread")
def on_join_thread(data):
    username = (data.get("username") or "Spotter").strip()
    thread_id = int(data.get("thread_id", 1))
    status = (data.get("status") or "En Route").strip()
    prev = online_users.get(request.sid)
    if prev and prev.get("thread_id"):
        leave_room(f"thread_{prev['thread_id']}")

    join_room(f"thread_{thread_id}")
    is_admin, is_owner = get_role_flags(username)
    online_users[request.sid] = {
        "username": username,
        "thread_id": thread_id,
        "status": prev.get("status", status) if prev else status,
        "is_admin": prev.get("is_admin", is_admin) if prev else is_admin,
        "is_owner": prev.get("is_owner", is_owner) if prev else is_owner,
        "lat": prev.get("lat") if prev else None,
        "lon": prev.get("lon") if prev else None,
        "last_checkin": prev.get("last_checkin", datetime.utcnow()) if prev else datetime.utcnow(),
        "escalated": prev.get("escalated", False) if prev else False,
    }
    broadcast_presence()


@socketio.on("send_message")
def on_send_message(data):
    thread_id = int(data.get("thread_id", 1))
    sender = (data.get("sender") or "Spotter").strip()
    body = (data.get("body") or "").strip()
    msg_type = data.get("msg_type", "text")
    media_url = data.get("media_url")
    reply_to_id = data.get("reply_to_id")
    reply_preview = (data.get("reply_preview") or "").strip() or None
    lat = data.get("lat")
    lon = data.get("lon")

    if not body and not media_url:
        return

    entry = online_users.get(request.sid)
    is_admin = bool(entry.get("is_admin")) if entry else get_role_flags(sender)[0]

    thread = db.session.get(Thread, thread_id)
    if thread and thread.is_locked and not is_admin:
        emit("system_notice", {"message": "🔒 Channel is locked by Admin."})
        return

    if entry:
        entry["last_checkin"] = datetime.utcnow()
        entry["escalated"] = False
        if lat is not None and lon is not None:
            entry["lat"] = float(lat)
            entry["lon"] = float(lon)
        broadcast_presence()

    msg = Message(
        thread_id=thread_id,
        sender=sender,
        body=body,
        msg_type=msg_type,
        media_url=media_url,
        reply_to_id=int(reply_to_id) if reply_to_id else None,
        reply_preview=reply_preview,
    )
    db.session.add(msg)
    db.session.commit()

    payload = serialize_message(msg)
    emit("new_message", payload, to=f"thread_{thread_id}")
    emit("thread_preview_update", payload, broadcast=True)


@socketio.on("global_broadcast")
def on_global_broadcast(data):
    entry = online_users.get(request.sid)
    if not entry or not entry.get("is_admin"):
        emit("system_notice", {"message": "Admin privileges required."})
        return

    sender = entry["username"]
    text = (data.get("body") or "").strip()
    if not text:
        return

    threads = Thread.query.all()
    for t in threads:
        msg = Message(
            thread_id=t.id,
            sender=f"📡 ADMIN ({sender})",
            body=f"ALL-HANDS BROADCAST: {text}",
            msg_type="alert",
        )
        db.session.add(msg)
        db.session.commit()
        payload = serialize_message(msg)
        emit("new_message", payload, to=f"thread_{t.id}")
        emit("thread_preview_update", payload, broadcast=True)


@socketio.on("toggle_lock")
def on_toggle_lock(data):
    entry = online_users.get(request.sid)
    if not entry or not entry.get("is_admin"):
        emit("system_notice", {"message": "Admin privileges required."})
        return

    thread_id = int(data.get("thread_id", 1))
    thread = db.session.get(Thread, thread_id)
    if not thread:
        return

    thread.is_locked = not bool(thread.is_locked)
    db.session.commit()
    emit(
        "thread_lock_updated",
        {"thread_id": thread_id, "is_locked": bool(thread.is_locked)},
        broadcast=True,
    )


@socketio.on("edit_message")
def on_edit_message(data):
    message_id = int(data.get("message_id", 0))
    thread_id = int(data.get("thread_id", 1))
    username = (data.get("username") or "").strip()
    new_body = (data.get("body") or "").strip()
    if not message_id or not username or not new_body:
        return

    msg = db.session.get(Message, message_id)
    if not msg or msg.sender != username or msg.msg_type in {"location", "nws", "audio"}:
        return

    msg.body = new_body
    msg.edited_at = datetime.utcnow().strftime("%I:%M %p")
    db.session.commit()

    payload = serialize_message(msg)
    emit("message_edited", payload, to=f"thread_{thread_id}")
    latest_msg = (
        Message.query.filter_by(thread_id=thread_id)
        .order_by(Message.id.desc())
        .first()
    )
    if latest_msg and latest_msg.id == msg.id:
        emit("thread_preview_update", payload, broadcast=True)


@socketio.on("toggle_pin")
def on_toggle_pin(data):
    message_id = int(data.get("message_id", 0))
    thread_id = int(data.get("thread_id", 1))
    msg = db.session.get(Message, message_id)
    if not msg or msg.thread_id != thread_id:
        return

    new_pin_state = not bool(msg.is_pinned)
    Message.query.filter_by(thread_id=thread_id).update({"is_pinned": False})
    msg.is_pinned = new_pin_state
    db.session.commit()

    pinned_payload = serialize_message(msg) if new_pin_state else None
    emit(
        "pin_updated",
        {
            "thread_id": thread_id,
            "pinned": pinned_payload,
            "pinned_id": msg.id if new_pin_state else None,
        },
        to=f"thread_{thread_id}",
    )


@socketio.on("delete_message")
def on_delete_message(data):
    message_id = int(data.get("message_id", 0))
    thread_id = int(data.get("thread_id", 1))
    username = (data.get("username") or "").strip()
    if not message_id or not username:
        return

    entry = online_users.get(request.sid)
    is_admin = bool(entry.get("is_admin")) if entry else get_role_flags(username)[0]

    msg = db.session.get(Message, message_id)
    if not msg or (msg.sender != username and not is_admin):
        return

    was_pinned = bool(msg.is_pinned)
    if msg.media_url and msg.media_url.startswith("/static/uploads/"):
        file_path = os.path.join(app.root_path, msg.media_url.lstrip("/"))
        if os.path.exists(file_path):
            try:
                os.remove(file_path)
            except OSError:
                pass

    Reaction.query.filter_by(message_id=message_id).delete()
    db.session.delete(msg)
    db.session.commit()

    latest_msg = (
        Message.query.filter_by(thread_id=thread_id)
        .order_by(Message.id.desc())
        .first()
    )

    emit(
        "message_deleted",
        {
            "thread_id": thread_id,
            "message_id": message_id,
            "was_pinned": was_pinned,
            "preview": format_thread_preview(latest_msg),
            "last_time": latest_msg.created_at.strftime("%I:%M %p") if latest_msg else "",
        },
        to=f"thread_{thread_id}",
    )
    emit(
        "thread_preview_after_delete",
        {
            "thread_id": thread_id,
            "preview": format_thread_preview(latest_msg),
            "last_time": latest_msg.created_at.strftime("%I:%M %p") if latest_msg else "",
        },
        broadcast=True,
    )


@socketio.on("toggle_reaction")
def on_toggle_reaction(data):
    message_id = int(data.get("message_id", 0))
    thread_id = int(data.get("thread_id", 1))
    username = (data.get("username") or "Spotter").strip()
    emoji = (data.get("emoji") or "").strip()
    if not message_id or not emoji:
        return

    existing = Reaction.query.filter_by(
        message_id=message_id, username=username, emoji=emoji
    ).first()
    if existing:
        db.session.delete(existing)
    else:
        db.session.add(Reaction(message_id=message_id, username=username, emoji=emoji))
    db.session.commit()

    emit(
        "reaction_updated",
        {
            "thread_id": thread_id,
            "message_id": message_id,
            "reactions": serialize_reactions(message_id),
        },
        to=f"thread_{thread_id}",
    )


@socketio.on("typing")
def on_typing(data):
    thread_id = int(data.get("thread_id", 1))
    sender = (data.get("sender") or "Spotter").strip()
    is_typing = bool(data.get("is_typing", False))
    emit(
        "typing_status",
        {"thread_id": thread_id, "sender": sender, "is_typing": is_typing},
        to=f"thread_{thread_id}",
        include_self=False,
    )


@socketio.on("mark_seen")
def on_mark_seen(data):
    thread_id = int(data.get("thread_id", 1))
    username = (data.get("username") or "Spotter").strip()
    last_message_id = int(data.get("last_message_id", 0))
    if last_message_id <= 0:
        return

    rec = ReadReceipt.query.filter_by(thread_id=thread_id, username=username).first()
    if not rec:
        rec = ReadReceipt(
            thread_id=thread_id, username=username, last_message_id=last_message_id
        )
        db.session.add(rec)
    elif last_message_id > rec.last_message_id:
        rec.last_message_id = last_message_id
    db.session.commit()

    emit(
        "seen_update",
        {"thread_id": thread_id, "username": username, "last_message_id": rec.last_message_id},
        to=f"thread_{thread_id}",
    )


@socketio.on("disconnect")
def on_disconnect():
    online_users.pop(request.sid, None)
    broadcast_presence()


if __name__ == "__main__":
    start_background_workers()
    socketio.run(app, host="0.0.0.0", port=5000, debug=True)

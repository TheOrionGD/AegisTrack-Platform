import os
import json
import math
import secrets
import base64
import io
import qrcode
from datetime import datetime, timedelta, timezone
from urllib.parse import quote_plus
import requests
import re

from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address

from dotenv import load_dotenv
from functools import wraps
from flask import Flask, request, jsonify, make_response, redirect, send_file
from flask_cors import CORS
from flask_jwt_extended import (
    JWTManager,
    create_access_token,
    create_refresh_token,
    decode_token,
    get_jwt_identity,
    jwt_required,
    get_jwt,
)
from flask_sock import Sock
from passlib.hash import pbkdf2_sha256
from pymongo import MongoClient, errors

# Load environment variables from .env if available
load_dotenv()

app = Flask(__name__)
app.config['JWT_SECRET_KEY'] = os.getenv('JWT_SECRET_KEY', 'change-this-secret')
app.config['JWT_ACCESS_TOKEN_EXPIRES'] = timedelta(minutes=20)
app.config['JWT_REFRESH_TOKEN_EXPIRES'] = timedelta(days=7)

# CYBERSECURITY: Rate Limiting to prevent brute force
limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    default_limits=["1000 per day", "200 per hour"],  # general limit
    storage_uri="memory://"
)

# Globally exempt browser preflight OPTIONS requests (CORS preflight checks) from rate limiting
@limiter.request_filter
def exempt_options():
    return request.method == "OPTIONS"

CORS(app, supports_credentials=True, resources={r"/*": {"origins": "*", "allow_headers": "*", "methods": "*"}}) 
jwt = JWTManager(app)

@jwt.additional_claims_loader
def add_claims_to_access_token(identity):
    # Determine the role of the user logging in
    user = users.find_one({'username': identity})
    if user:
        role = user.get('role', 'OPERATOR')
        claims = {'role': role}
        if role == 'DEVICE_OWNER':
            claims['ownerId'] = identity
            claims['deviceId'] = user.get('device_id')
        else:
            claims['operatorId'] = identity
        return claims
    return {'role': 'OPERATOR', 'operatorId': identity}


def operator_required():
    def wrapper(fn):
        @wraps(fn)
        @jwt_required()
        def decorator(*args, **kwargs):
            claims = get_jwt()
            if claims.get('role') != 'OPERATOR':
                return jsonify({'error': 'Unauthorized. Operator role required.'}), 403
            return fn(*args, **kwargs)
        return decorator
    return wrapper


def owner_required():
    def wrapper(fn):
        @wraps(fn)
        @jwt_required()
        def decorator(*args, **kwargs):
            claims = get_jwt()
            if claims.get('role') != 'DEVICE_OWNER':
                return jsonify({'error': 'Unauthorized. Device Owner role required.'}), 403
            return fn(*args, **kwargs)
        return decorator
    return wrapper

sock = Sock(app)

# CYBERSECURITY: Vault Encryption Key Derivation
def get_vault_cipher():
    secret = app.config['JWT_SECRET_KEY'].encode()
    salt = b'aegistrack_security_salt' # In production, use a unique salt from env
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=100000,
    )
    key = base64.urlsafe_b64encode(kdf.derive(secret))
    return Fernet(key)

cipher = get_vault_cipher()

MONGODB_URI = os.getenv('MONGODB_URI')

try:
    print("CONNECTING TO MONGODB ATLAS CONFIGURATION...")
    mongo_client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
    mongo_client.admin.command('ping')
    print("MONGODB ATLAS CONNECTION VERIFIED.")
except Exception as e:
    print(f"MONGODB ATLAS UNREACHABLE ({e}). FALLING BACK TO LOCAL ENDPOINT...")
    try:
        mongo_client = MongoClient('mongodb://localhost:27017/', serverSelectionTimeoutMS=2000)
        mongo_client.admin.command('ping')
        print("LOCAL MONGODB CONNECTION VERIFIED.")
    except Exception as local_err:
        print(f"LOCAL MONGODB UNREACHABLE ({local_err}). DATABASE IS OFFLINE.")
        mongo_client = MongoClient('mongodb://localhost:27017/', serverSelectionTimeoutMS=2000)

db = mongo_client['aegistrack']
users = db['users']
devices = db['devices']
locations = db['locations']
geofences = db['geofences']
alerts = db['alerts']
vault_analytics = db['vault_analytics']
vault_threats = db['vault_threats']
vault_logs = db['vault_logs']
vault_files = db['vault_files']
vault_operators = db['vault_operators']
vault_config = db['vault_config']
tracking_requests = db['tracking_requests']
device_registrations = db['device_registrations']
consent_audit_logs = db['consent_audit_logs']

# Create helpful indexes if they don't already exist
try:
    users.create_index('username', unique=True)
    devices.create_index('device_id', unique=True)
    locations.create_index([('device_id', 1), ('timestamp', -1)])
    geofences.create_index('device_id', unique=True)
    tracking_requests.create_index('token', unique=True)
    tracking_requests.create_index('phone_number')
    device_registrations.create_index('device_id', unique=True)
    consent_audit_logs.create_index('timestamp')
    print("DATABASE INDEXES INITIALIZED.")
except errors.ServerSelectionTimeoutError as e:
    print(f"DATABASE INDEX CREATION SKIPPED - MongoDB is offline: {e}")
except Exception as e:
    print(f"DATABASE INDEX CREATION SKIPPED: {e}")


def ensure_default_operator():
    default_username = os.getenv('OPERATOR_USERNAME')
    default_password = os.getenv('OPERATOR_PASSWORD')
    
    existing_operator = users.find_one({'username': default_username})
    if not existing_operator:
        users.insert_one({
            'username': default_username,
            'password': hash_password(default_password),
            'role': 'OPERATOR',
            'created_at': datetime.now(timezone.utc)
        })
        vault_operators.insert_one({
            'owner': default_username,
            'data': {'name': default_username.split('@')[0].upper(), 'role': 'Tracking Operator', 'status': 'Active'},
            'created_at': datetime.now(timezone.utc)
        })
        print(f"Default operator '{default_username}' initialized securely.")
    else:
        # If the operator exists but the password in .env has changed, sync it automatically
        if not verify_password(default_password, existing_operator['password']):
            users.update_one(
                {'username': default_username},
                {'$set': {'password': hash_password(default_password)}}
            )
            print(f"Operator '{default_username}' password securely synchronized from environment.")



active_sockets = []
# MongoDB-backed force-location request store
force_location_requests = db['force_location_requests']
API_KEY_HEADER = 'X-API-KEY'


def to_json(doc):
    if not doc:
        return None
    result = {}
    for key, value in doc.items():
        if key == '_id':
            continue
        if isinstance(value, datetime):
            result[key] = value.isoformat()
        else:
            result[key] = value
    return result


def hash_password(password):
    return pbkdf2_sha256.hash(password)


def verify_password(password, hashed_password):
    return pbkdf2_sha256.verify(password, hashed_password)


# Ensure default operator exists after helpers are defined
try:
    ensure_default_operator()
except errors.ServerSelectionTimeoutError as e:
    print(f"DEFAULT OPERATOR INITIALIZATION SKIPPED - MongoDB is offline: {e}")
except Exception as e:
    print(f"DEFAULT OPERATOR INITIALIZATION SKIPPED: {e}")


def generate_api_key():
    return secrets.token_urlsafe(32)


def base36_encode(number):
    if not isinstance(number, int):
        raise TypeError('number must be an integer')
    if number < 0:
        raise ValueError('number must be positive')
    alphabet = '0123456789abcdefghijklmnopqrstuvwxyz'
    base36 = ''
    while number:
        number, i = divmod(number, 36)
        base36 = alphabet[i] + base36
    return base36 or '0'


def generate_secure_token():
    hex_part = secrets.token_hex(16)
    ms_now = int(datetime.now(timezone.utc).timestamp() * 1000)
    base36_part = base36_encode(ms_now)
    return f"{hex_part}-{base36_part}"


def haversine(lat1, lon1, lat2, lon2):
    radius = 6371000
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = math.sin(dlat / 2) ** 2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dlon / 2) ** 2
    c = 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    return radius * c


def broadcast(event, payload, owner=None):
    message = json.dumps({'event': event, 'payload': payload})
    for ws_entry in active_sockets.copy():
        sock_obj = ws_entry.get('sock')
        if owner and ws_entry.get('user') != owner:
            continue
        try:
            sock_obj.send(message)
        except Exception:
            active_sockets.remove(ws_entry)
def cleanup_expired_tokens_worker():
    import time
    from datetime import datetime, timezone
    while True:
        try:
            now = datetime.now(timezone.utc)
            # Find requests that have expired but are still in active states
            expired_reqs = list(tracking_requests.find({
                'status': {'$in': ['PENDING', 'LINK_GENERATED', 'LINK_COPIED', 'WHATSAPP_OPENED', 'EMAIL_OPENED']},
                'expires_at': {'$lt': now}
            }))
            
            for req in expired_reqs:
                token = req.get('token')
                operator_id = req.get('operator_id') or req.get('created_by')
                
                # Update in DB
                tracking_requests.update_one({'_id': req['_id']}, {'$set': {'status': 'EXPIRED'}})
                
                # Broadcast real-time transition via WebSocket
                broadcast('status_updated', {
                    'token': token,
                    'status': 'EXPIRED',
                    'message': 'Tracking request link has expired automatically.'
                }, owner=operator_id)
                
        except Exception as e:
            print(f"Error in cleanup worker: {e}", flush=True)
        time.sleep(5)  # Check every 5 seconds

# Start the daemon cleanup worker thread
import threading
threading.Thread(target=cleanup_expired_tokens_worker, daemon=True).start()


def user_from_token(token):
    try:
        decoded = decode_token(token)
        return decoded.get('sub') or decoded.get('identity')
    except Exception:
        return None


def get_device(device_id):
    return devices.find_one({'device_id': device_id})


def verify_device_for_user(device_id, api_key, username):
    device = get_device(device_id)
    return device and device.get('api_key') == api_key and device.get('owner') == username


def get_system_ipv4():
    env_ip = os.getenv('SYSTEM_IPV4') or os.getenv('PUBLIC_HOST')
    if env_ip:
        return env_ip
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.254.254.254", 1))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return "127.0.0.1"


def get_public_host():
    # Use explicit public host if configured for QR scanning from other devices
    host = os.getenv('SYSTEM_IPV4') or os.getenv('PUBLIC_HOST')
    if not host:
        req_host = request.host.split(':')[0]
        if req_host in ("localhost", "127.0.0.1"):
            host = get_system_ipv4()
        else:
            host = req_host
    return host


def get_frontend_url():
    env_frontend = os.getenv('FRONTEND_URL')
    if env_frontend:
        return env_frontend.rstrip('/')
    host = get_public_host()
    frontend_port = os.getenv('FRONTEND_PORT', '8000')
    return f"http://{host}:{frontend_port}"


def get_backend_url():
    env_backend = os.getenv('BACKEND_URL')
    if env_backend:
        return env_backend.rstrip('/')
    host = get_public_host()
    if os.getenv('RENDER') == 'true' or 'onrender.com' in host:
        return f"https://{host}"
    backend_port = os.getenv('BACKEND_PORT', '5000')
    return f"http://{host}:{backend_port}"


# CYBERSECURITY: Security Headers & CORS Middleware
@app.after_request
def add_security_headers(response):
    # Fix CORS preflight issue: Explicitly allow headers
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-API-KEY'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS, PUT, DELETE'
    
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'DENY'
    response.headers['X-XSS-Protection'] = '1; mode=block'
    response.headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains'
    response.headers['Content-Security-Policy'] = "default-src 'self' http://*:* https://*:*; script-src 'self' 'unsafe-inline' cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' cdnjs.cloudflare.com fonts.googleapis.com; font-src 'self' cdnjs.cloudflare.com fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self' http://*:* https://*:* ws://*:* wss://*:*;"
    return response


@app.route('/')
def home():
    return jsonify({'message': 'AegisTrack Cybersecurity Core API', 'status': 'PROTECTED'})


@app.route('/register', methods=['POST', 'OPTIONS'])
@app.route('/auth/register', methods=['POST', 'OPTIONS'])
@limiter.limit("5 per hour")
def register_user():
    if request.method == 'OPTIONS':
        return '', 200
    data = request.get_json() or {}
    username = data.get('username')
    password = data.get('password')

    if not username or not password:
        return jsonify({'error': 'username and password are required'}), 400

    if users.find_one({'username': username}):
        return jsonify({'error': 'Username already exists'}), 409

    users.insert_one({
        'username': username,
        'password': hash_password(password),
        'role': 'OPERATOR',
        'created_at': datetime.now(timezone.utc)
    })

    # CYBERSECURITY: Audit Log for Registration
    vault_logs.insert_one({
        'owner': username,
        'data': cipher.encrypt(json.dumps({'event': 'OPERATOR_PROVISIONED', 'ip': request.remote_addr}).encode()),
        'created_at': datetime.now(timezone.utc),
        'encrypted': True
    })
    
    vault_operators.insert_one({
        'owner': username,
        'data': {'name': username.upper(), 'role': 'System Administrator', 'status': 'Active'},
        'created_at': datetime.now(timezone.utc)
    })

    return jsonify({'message': 'Operator profile established in secure registry'}), 201


@app.route('/login', methods=['POST', 'OPTIONS'])
@app.route('/auth/login', methods=['POST', 'OPTIONS'])
@limiter.limit("10 per minute")
def login_user():
    if request.method == 'OPTIONS':
        return '', 200
    data = request.get_json() or {}
    username = data.get('username')
    password = data.get('password')

    if not username or not password:
        return jsonify({'error': 'username and password are required'}), 400

    user = users.find_one({'username': username})
    if not user or not verify_password(password, user['password']):
        # CYBERSECURITY: Log failed login attempt
        vault_logs.insert_one({
            'owner': 'SYSTEM',
            'data': cipher.encrypt(json.dumps({'event': 'AUTH_FAILURE', 'target': username, 'ip': request.remote_addr}).encode()),
            'created_at': datetime.now(timezone.utc),
            'encrypted': True
        })
        return jsonify({'error': 'Invalid username or password'}), 401

    access_token = create_access_token(identity=username)
    refresh_token = create_refresh_token(identity=username)
    registered_devices = list(devices.find({'owner': username}, {'_id': 0, 'device_id': 1, 'api_key': 1}))

    # CYBERSECURITY: Audit Log for Success
    now = datetime.now(timezone.utc)
    vault_logs.insert_one({
        'owner': username,
        'data': cipher.encrypt(json.dumps({'event': 'C2_ACCESS_GRANTED', 'ip': request.remote_addr}).encode()),
        'created_at': now,
        'encrypted': True
    })
    consent_audit_logs.insert_one({
        'event': 'ACCESS_GRANTED',
        'performed_by': username,
        'details': {'ip': request.remote_addr},
        'timestamp': now
    })

    return jsonify({
        'access_token': access_token,
        'refresh_token': refresh_token,
        'role': user.get('role', 'OPERATOR'),
        'devices': registered_devices,
        'message': 'C2 Access Granted. Session JWT issued.'
    }), 200


@app.route('/auth/owner-login', methods=['POST', 'OPTIONS'])
@limiter.limit("10 per minute")
def owner_login():
    if request.method == 'OPTIONS':
        return '', 200
    data = request.get_json() or {}
    email = data.get('email') or data.get('username')
    password = data.get('password')

    if not email or not password:
        return jsonify({'error': 'Email and password are required'}), 400

    user = users.find_one({'username': email, 'role': 'DEVICE_OWNER'})
    if not user or not verify_password(password, user['password']):
        # Log failed login attempt
        vault_logs.insert_one({
            'owner': 'SYSTEM',
            'data': cipher.encrypt(json.dumps({'event': 'OWNER_AUTH_FAILURE', 'target': email, 'ip': request.remote_addr}).encode()),
            'created_at': datetime.now(timezone.utc),
            'encrypted': True
        })
        return jsonify({'error': 'Invalid email or password'}), 401

    access_token = create_access_token(identity=email)
    refresh_token = create_refresh_token(identity=email)

    # Log Success
    now = datetime.now(timezone.utc)
    vault_logs.insert_one({
        'owner': email,
        'data': cipher.encrypt(json.dumps({'event': 'OWNER_ACCESS_GRANTED', 'ip': request.remote_addr}).encode()),
        'created_at': now,
        'encrypted': True
    })
    consent_audit_logs.insert_one({
        'event': 'OWNER_ACCESS_GRANTED',
        'performed_by': email,
        'details': {'ip': request.remote_addr},
        'timestamp': now
    })

    return jsonify({
        'access_token': access_token,
        'refresh_token': refresh_token,
        'role': 'DEVICE_OWNER',
        'device_id': user.get('device_id'),
        'message': 'Device Owner Access Granted.'
    }), 200


@app.route('/my-device', methods=['GET'])
@owner_required()
def get_my_device():
    claims = get_jwt()
    device_id = claims.get('deviceId')
    username = get_jwt_identity()

    reg = device_registrations.find_one({'device_id': device_id, 'owner_username': username})
    device = devices.find_one({'device_id': device_id})
    if not reg or not device:
        return jsonify({'error': 'Device registration not found'}), 404

    geofence = geofences.find_one({'device_id': device_id})
    gf_data = None
    if geofence:
        gf_data = {
            'center_lat': geofence.get('center_lat'),
            'center_lng': geofence.get('center_lng'),
            'radius_meters': geofence.get('radius_meters'),
            'is_inside': geofence.get('is_inside', True)
        }

    return jsonify({
        'owner_name': reg.get('owner_name') or device.get('owner_name'),
        'device_name': device.get('device_name'),
        'device_model': device.get('device_model'),
        'latitude': device.get('latitude'),
        'longitude': device.get('longitude'),
        'accuracy': device.get('accuracy'),
        'tracking_status': device.get('tracking_status'),
        'last_updated': to_json(device).get('last_updated'),
        'geofence_inside': device.get('geofence_inside', True),
        'consent_status': reg.get('consent_status', 'GRANTED'),
        'device_id': device_id,
        'geofence': gf_data
    }), 200


@app.route('/my-device/consent', methods=['POST', 'OPTIONS'])
@owner_required()
def manage_my_consent():
    if request.method == 'OPTIONS':
        return '', 200
    
    data = request.get_json() or {}
    action = data.get('action')
    if action not in ('pause', 'resume', 'revoke'):
        return jsonify({'error': 'Invalid action. Must be pause, resume, or revoke.'}), 400
        
    claims = get_jwt()
    device_id = claims.get('deviceId')
    username = get_jwt_identity()
    
    registration = device_registrations.find_one({'device_id': device_id, 'owner_username': username})
    if not registration:
        return jsonify({'error': 'Device registration not found'}), 404
        
    now = datetime.now(timezone.utc)
    
    if action == 'pause':
        device_registrations.update_one({'_id': registration['_id']}, {'$set': {'tracking_status': 'PAUSED', 'last_updated': now}})
        devices.update_one({'device_id': device_id}, {'$set': {'tracking_status': 'PAUSED', 'last_updated': now}})
        tracking_requests.update_one({'token': registration.get('request_token')}, {'$set': {'status': 'PAUSED'}})
        
        consent_audit_logs.insert_one({
            'event': 'TRACKING_PAUSED',
            'performed_by': username,
            'details': {'device_id': device_id},
            'timestamp': now
        })
        
        ws_payload = {'device_id': device_id, 'tracking_status': 'PAUSED'}
        broadcast('status_updated', ws_payload, owner=registration.get('operator_id'))
        broadcast('status_updated', ws_payload, owner=username)
        
        return jsonify({'message': 'Tracking paused', 'tracking_status': 'PAUSED'}), 200
        
    elif action == 'resume':
        device_registrations.update_one({'_id': registration['_id']}, {'$set': {'tracking_status': 'TRACKING_ACTIVE', 'last_updated': now}})
        devices.update_one({'device_id': device_id}, {'$set': {'tracking_status': 'TRACKING_ACTIVE', 'last_updated': now}})
        tracking_requests.update_one({'token': registration.get('request_token')}, {'$set': {'status': 'TRACKING_ACTIVE'}})
        
        consent_audit_logs.insert_one({
            'event': 'TRACKING_RESUMED',
            'performed_by': username,
            'details': {'device_id': device_id},
            'timestamp': now
        })
        
        ws_payload = {'device_id': device_id, 'tracking_status': 'TRACKING_ACTIVE'}
        broadcast('status_updated', ws_payload, owner=registration.get('operator_id'))
        broadcast('status_updated', ws_payload, owner=username)
        
        return jsonify({'message': 'Tracking resumed', 'tracking_status': 'TRACKING_ACTIVE'}), 200
        
    elif action == 'revoke':
        device_registrations.update_one({'_id': registration['_id']}, {'$set': {'tracking_status': 'REVOKED', 'consent_status': 'REVOKED', 'revoked_at': now}})
        devices.update_one({'device_id': device_id}, {'$set': {'tracking_status': 'REVOKED', 'consent_status': 'REVOKED', 'last_updated': now}})
        tracking_requests.update_one({'token': registration.get('request_token')}, {'$set': {'status': 'REVOKED'}})
        
        consent_audit_logs.insert_one({
            'event': 'CONSENT_REVOKED',
            'performed_by': username,
            'details': {'device_id': device_id, 'request_token': registration.get('request_token')},
            'timestamp': now
        })
        
        vault_logs.insert_one({
            'owner': registration.get('owner_name'),
            'data': cipher.encrypt(json.dumps({'event': 'CONSENT_REVOKED', 'device_id': device_id}).encode()),
            'created_at': now,
            'encrypted': True
        })
        
        ws_payload = {'device_id': device_id, 'tracking_status': 'REVOKED', 'consent_status': 'REVOKED'}
        broadcast('status_updated', ws_payload, owner=registration.get('operator_id'))
        broadcast('status_updated', ws_payload, owner=username)
        
        return jsonify({'message': 'Consent withdrawn', 'tracking_status': 'REVOKED', 'consent_status': 'REVOKED'}), 200


@app.route('/auth/refresh', methods=['POST', 'OPTIONS'])
@jwt_required(refresh=True)
def refresh_session():
    if request.method == 'OPTIONS':
        return '', 200
    username = get_jwt_identity()
    new_access_token = create_access_token(identity=username)
    return jsonify({'access_token': new_access_token}), 200


@app.route('/devices/register', methods=['POST'])
@operator_required()
def register_device():
    username = get_jwt_identity()
    data = request.get_json() or {}
    device_id = data.get('device_id')

    if not device_id:
        return jsonify({'error': 'device_id is required'}), 400

    existing = devices.find_one({'device_id': device_id})
    if existing:
        if existing.get('owner') != username:
            return jsonify({'error': 'Device is owned by another account'}), 403
        return jsonify(to_json(existing)), 200

    api_key = generate_api_key()
    device_doc = {
        'device_id': device_id,
        'owner': username,
        'api_key': api_key,
        'created_at': datetime.now(timezone.utc),
        'latitude': None,
        'longitude': None,
        'accuracy': None,
        'timestamp': None,
        'last_updated': None,
        'geofence_inside': True
    }
    devices.insert_one(device_doc)
    return jsonify(to_json(device_doc)), 201


@app.route('/devices', methods=['GET'])
@operator_required()
def list_devices():
    username = get_jwt_identity()
    device_cursor = devices.find({'owner': username}, {'_id': 0, 'device_id': 1, 'latitude': 1, 'longitude': 1, 'accuracy': 1, 'timestamp': 1, 'last_updated': 1, 'geofence_inside': 1})
    return jsonify({'devices': [to_json(device) for device in device_cursor]}), 200


@app.route('/dashboard/summary', methods=['GET'])
@operator_required()
def get_dashboard_summary():
    username = get_jwt_identity()
    user_devices = [device['device_id'] for device in devices.find({'owner': username}, {'device_id': 1})]
    
    active_devices_count = devices.count_documents({
        'owner': username,
        'tracking_status': {'$in': ['ACTIVE', 'TRACKING_ACTIVE']}
    })
    
    requests_count = tracking_requests.count_documents({
        'operator_id': username
    })
    
    alerts_count = alerts.count_documents({
        'device_id': {'$in': user_devices}
    })
    
    return jsonify({
        'activeDevices': active_devices_count,
        'trackingRequests': requests_count,
        'alerts': alerts_count
    }), 200


@app.route('/device-locations', methods=['GET'])
@operator_required()
def get_all_device_locations():
    username = get_jwt_identity()
    cursor = device_registrations.find({'operator_id': username}, {'_id': 0, 'device_id': 1, 'owner_name': 1})
    locations_list = []
    for doc in cursor:
        device_id = doc.get('device_id')
        live = devices.find_one({'device_id': device_id}, {'_id': 0, 'latitude': 1, 'longitude': 1, 'accuracy': 1, 'timestamp': 1})
        if live and live.get('latitude') is not None and live.get('longitude') is not None:
            locations_list.append({
                'device_id': device_id,
                'owner_name': doc.get('owner_name'),
                'latitude': live.get('latitude'),
                'longitude': live.get('longitude'),
                'accuracy': live.get('accuracy'),
                'timestamp': live.get('timestamp')
            })
    return jsonify({'locations': locations_list}), 200


def send_sms_message(phone_number, message, owner=None):
    # Prefer Twilio if credentials are provided
    tw_sid = os.getenv('TWILIO_ACCOUNT_SID')
    tw_token = os.getenv('TWILIO_AUTH_TOKEN')
    tw_from = os.getenv('TWILIO_FROM')

    sms_gateway_url = os.getenv('SMS_GATEWAY_URL')
    sms_api_key = os.getenv('SMS_API_KEY')
    sms_sender = os.getenv('SMS_SENDER', tw_from or 'AegisTrack')

    # 1) Twilio REST API
    if tw_sid and tw_token and tw_from:
        try:
            tw_url = f'https://api.twilio.com/2010-04-01/Accounts/{tw_sid}/Messages.json'
            payload = {
                'From': tw_from,
                'To': phone_number,
                'Body': message
            }
            resp = requests.post(tw_url, data=payload, auth=(tw_sid, tw_token), timeout=10)
            return resp.status_code in (200, 201)
        except Exception:
            # fall through to other gateways / logging
            pass

    # 2) Generic gateway (custom API)
    if sms_gateway_url and sms_api_key:
        try:
            response = requests.post(
                sms_gateway_url,
                json={
                    'from': sms_sender,
                    'to': phone_number,
                    'message': message
                },
                headers={'Authorization': f'Bearer {sms_api_key}', 'Content-Type': 'application/json'},
                timeout=10
            )
            return response.status_code in (200, 201)
        except Exception:
            pass

    # 3) No SMS provider configured — securely record the preview in vault_logs for operator retrieval
    try:
        vault_logs.insert_one({
            'owner': owner or 'system',
            'data': cipher.encrypt(json.dumps({'event': 'SMS_PREVIEW', 'to': phone_number, 'message': message}).encode()),
            'created_at': datetime.now(timezone.utc),
            'encrypted': True,
            'note': 'No SMS gateway configured; preview stored'
        })
    except Exception:
        pass
    return False


def render_html_email(request_doc):
    owner_name = request_doc.get('owner_name') or ''
    organization_name = request_doc.get('organization_name') or ''
    tracking_purpose = request_doc.get('tracking_purpose') or ''
    
    # Format duration nicely
    duration = str(request_doc.get('tracking_duration') or '')
    if duration and not duration.lower().endswith('days') and not duration.lower().endswith('day'):
        duration = f"{duration} Days"
        
    requested_by = request_doc.get('created_by') or request_doc.get('operator_id') or ''
    
    # Format expiry date nicely
    consent_expiry = request_doc.get('consent_expiry_date') or ''
    
    # Base registration URL
    registration_link = f"{get_backend_url()}/register-device/{request_doc.get('token')}"

    # Get QR base64
    qr_b64 = request_doc.get('qrBase64') or request_doc.get('qr_base64')
    if not qr_b64:
        try:
            qr = qrcode.make(registration_link)
            buf = io.BytesIO()
            qr.save(buf, format='PNG')
            qr_b64 = base64.b64encode(buf.getvalue()).decode()
        except Exception:
            qr_b64 = ''

    qr_image_src = f"data:image/png;base64,{qr_b64}" if qr_b64 else ''

    # Now let's replace all placeholders in the gorgeous table-based template
    html_template = """<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Action Required: Review Device Monitoring Request</title>
  <!--[if mso]>
  <noscript>
    <xml>
      <o:OfficeDocumentSettings>
        <o:AllowPNG/>
        <o:PixelsPerInch>96</o:PixelsPerInch>
      </o:OfficeDocumentSettings>
    </xml>
  </noscript>
  <![endif]-->
  <style>
    body { margin: 0; padding: 0; width: 100% !important; background-color: #f3f6f8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; }
    table, td { border-collapse: collapse; }
    .wrapper { width: 100%; table-layout: fixed; background-color: #f3f6f8; padding: 24px 0; }
    .main-table { width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; border: 1px solid #e1e9ee; overflow: hidden; }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#f3f6f8;">
  <table class="wrapper" width="100%" cellpadding="0" cellspacing="0" role="presentation">
    <tr>
      <td align="center">
        <table class="main-table" width="100%" cellpadding="0" cellspacing="0" role="presentation">
          <!-- HEADER: Dark Blue, Left Logo, Right Product -->
          <tr style="background-color: #1B365D;">
            <td style="padding: 20px 24px; vertical-align: middle;">
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td align="left" style="color: #ffffff; font-size: 16px; font-weight: 700; font-family: sans-serif;">
                    <span style="letter-spacing: 1px;">AegisTrack</span>
                  </td>
                  <td align="right" style="color: #cddcfa; font-size: 11px; font-weight: 500; font-family: sans-serif; text-transform: uppercase;">
                    Consent-Based Device Enrollment
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- HERO SECTION -->
          <tr>
            <td style="padding: 32px 32px 16px 32px; text-align: center;">
              <h1 style="margin: 0 0 12px 0; font-size: 22px; font-weight: 700; color: #1B365D; line-height: 28px;">
                Device Monitoring Authorization Request
              </h1>
              <p style="margin: 0; font-size: 14px; color: #66788a; line-height: 20px;">
                A request has been submitted for your review.<br>
                Tracking will only begin after your explicit approval.
              </p>
            </td>
          </tr>
          
          <!-- SEPARATOR -->
          <tr>
            <td style="padding: 0 32px;"><hr style="border: 0; border-top: 1px solid #eef2f5; margin: 0;"></td>
          </tr>
          
          <!-- CONTENT BODY -->
          <tr>
            <td style="padding: 24px 32px 16px 32px;">
              <p style="margin: 0 0 16px 0; font-size: 16px; font-weight: 600; color: #2d3748;">
                Hello {{owner_name}},
              </p>
              <p style="margin: 0 0 24px 0; font-size: 15px; color: #4a5568; line-height: 22px;">
                <strong>{{organization_name}}</strong> has requested your authorization to register and monitor a device associated with this mobile number.
              </p>
              
              <!-- DETAILS CARD (LinkedIn Style) -->
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.02); margin-bottom: 24px;">
                <tr>
                  <td style="padding: 20px;">
                    <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td width="48%" style="vertical-align: top; padding-bottom: 12px;">
                          <div style="font-size: 11px; text-transform: uppercase; color: #718096; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 2px;">Organization</div>
                          <div style="font-size: 14px; color: #1a202c; font-weight: 600;">{{organization_name}}</div>
                        </td>
                        <td width="4%"></td>
                        <td width="48%" style="vertical-align: top; padding-bottom: 12px;">
                          <div style="font-size: 11px; text-transform: uppercase; color: #718096; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 2px;">Purpose</div>
                          <div style="font-size: 14px; color: #1a202c; font-weight: 600;">{{tracking_purpose}}</div>
                        </td>
                      </tr>
                      <tr>
                        <td style="vertical-align: top; padding-bottom: 12px;">
                          <div style="font-size: 11px; text-transform: uppercase; color: #718096; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 2px;">Duration</div>
                          <div style="font-size: 14px; color: #1a202c; font-weight: 600;">{{tracking_duration}}</div>
                        </td>
                        <td></td>
                        <td style="vertical-align: top; padding-bottom: 12px;">
                          <div style="font-size: 11px; text-transform: uppercase; color: #718096; font-weight: 600; letter-spacing: 0.5px; margin-bottom: 2px;">Requested By</div>
                          <div style="font-size: 14px; color: #1a202c; font-weight: 600;">{{requested_by}}</div>
                        </td>
                      </tr>
                      <tr>
                        <td colspan="3" style="vertical-align: top; padding-top: 4px; border-top: 1px dashed #e2e8f0;">
                          <div style="font-size: 11px; text-transform: uppercase; color: #e53e3e; font-weight: 600; letter-spacing: 0.5px; margin-top: 8px; margin-bottom: 2px;">Expires On</div>
                          <div style="font-size: 14px; color: #e53e3e; font-weight: 600;">{{consent_expiry}}</div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
              
              <!-- PRIMARY ACTION BUTTON -->
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                <tr>
                  <td align="center" style="padding: 12px 0 24px 0;">
                    <div><!--[if mso]>
                      <v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" xmlns:w="urn:schemas-microsoft-com:office:word" href="{{registration_link}}" style="height:48px;v-text-anchor:middle;width:200px;" arcsize="50%" stroke="f" fillcolor="#0A66C2">
                        <w:anchorlock/>
                        <center style="color:#ffffff;font-family:sans-serif;font-size:16px;font-weight:bold;">Review & Respond</center>
                      </v:roundrect>
                    <![endif]--><a href="{{registration_link}}" style="background-color:#0A66C2; border-radius:24px; color:#ffffff !important; display:inline-block; font-family:sans-serif; font-size:15px; font-weight:600; line-height:48px; text-align:center; text-decoration:none; width:220px; -webkit-text-size-adjust:none; box-shadow: 0 4px 6px rgba(10, 102, 194, 0.15);">Review & Respond</a></div>
                  </td>
                </tr>
              </table>

              <!-- OR / QR CODE SECTION -->
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="margin-top: 10px; margin-bottom: 20px;">
                <tr>
                  <td align="center" style="font-size: 14px; font-weight: 600; color: #718096; padding-bottom: 12px; text-transform: uppercase; letter-spacing: 1px;">
                    OR
                  </td>
                </tr>
                <tr>
                  <td align="center" style="font-size: 16px; font-weight: 700; color: #1B365D; padding-bottom: 16px;">
                    Scan This QR Code
                  </td>
                </tr>
                <tr>
                  <td align="center">
                    <img src="{{qrCodeImage}}" alt="Consent Portal QR Code" width="220" height="220" style="display: block; border: 1px solid #e1e9ee; border-radius: 8px; box-shadow: 0 4px 10px rgba(0,0,0,0.05);" />
                  </td>
                </tr>
                <tr>
                  <td align="center" style="font-size: 13px; color: #4a5568; padding-top: 12px; line-height: 18px;">
                    Scan this QR code to access the consent portal.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- CONSENT INFORMATION (What Happens Next) -->
          <tr>
            <td style="padding: 0 32px 24px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color: #ffffff; border: 1px solid #edf2f7; border-radius: 8px;">
                <tr>
                  <td style="padding: 20px;">
                    <h3 style="margin: 0 0 16px 0; font-size: 15px; color: #2d3748; font-weight: 700;">
                      What Happens Next?
                    </h3>
                    <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td width="24" style="vertical-align: top; padding-bottom: 8px; color: #0A66C2; font-weight: bold; font-size: 14px;">✓</td>
                        <td style="vertical-align: top; padding-bottom: 8px; font-size: 13px; color: #4a5568;">Review monitoring details</td>
                      </tr>
                      <tr>
                        <td width="24" style="vertical-align: top; padding-bottom: 8px; color: #0A66C2; font-weight: bold; font-size: 14px;">✓</td>
                        <td style="vertical-align: top; padding-bottom: 8px; font-size: 13px; color: #4a5568;">Read privacy policy</td>
                      </tr>
                      <tr>
                        <td width="24" style="vertical-align: top; padding-bottom: 8px; color: #0A66C2; font-weight: bold; font-size: 14px;">✓</td>
                        <td style="vertical-align: top; padding-bottom: 8px; font-size: 13px; color: #4a5568;">Grant or deny consent</td>
                      </tr>
                      <tr>
                        <td width="24" style="vertical-align: top; padding-bottom: 8px; color: #0A66C2; font-weight: bold; font-size: 14px;">✓</td>
                        <td style="vertical-align: top; padding-bottom: 8px; font-size: 13px; color: #4a5568;">Register your device</td>
                      </tr>
                      <tr>
                        <td width="24" style="vertical-align: top; color: #0A66C2; font-weight: bold; font-size: 14px;">✓</td>
                        <td style="vertical-align: top; font-size: 13px; color: #4a5568;">Revoke authorization later if needed</td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- SECURITY NOTICE -->
          <tr>
            <td style="padding: 0 32px 24px 32px;">
              <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="background-color: #ebf8ff; border-left: 4px solid #3182ce; border-radius: 4px;">
                <tr>
                  <td style="padding: 16px;">
                    <table width="100%" cellpadding="0" cellspacing="0" role="presentation">
                      <tr>
                        <td width="28" style="vertical-align: top; padding-right: 12px; font-size: 20px;">🛡️</td>
                        <td style="vertical-align: top;">
                          <div style="font-size: 14px; font-weight: 700; color: #2b6cb0; margin-bottom: 4px;">Your privacy matters.</div>
                          <div style="font-size: 13px; color: #2d3748; line-height: 18px;">
                            Tracking will <strong>NOT</strong> begin automatically. Location monitoring only becomes active after you review and approve the request.
                          </div>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          
          <!-- FALLBACK LINK -->
          <tr>
            <td style="padding: 0 32px 32px 32px; font-size: 12px; color: #718096; line-height: 18px; text-align: center;">
              <div style="margin-bottom: 4px; font-weight: 600;">Button not working?</div>
              <div>Copy and paste this link into your browser:</div>
              <div style="margin-top: 6px; font-family: monospace; word-break: break-all; color: #0A66C2; background-color: #f7fafc; padding: 8px; border-radius: 4px; border: 1px solid #edf2f7;">
                {{registration_link}}
              </div>
            </td>
          </tr>
          
          <!-- FOOTER -->
          <tr style="background-color: #f3f6f8; border-top: 1px solid #e1e9ee;">
            <td style="padding: 32px 32px 24px 32px; text-align: center; font-size: 12px; color: #66788a; line-height: 18px;">
              <p style="margin: 0 0 16px 0; font-weight: 600; color: #4a5568;">
                AegisTrack
              </p>
              <p style="margin: 0 0 24px 0;">
                This email was generated by <strong>AegisTrack</strong>.<br>
                You are receiving this message because a device monitoring authorization request was created using your contact information.
              </p>
              <table align="center" cellpadding="0" cellspacing="0" role="presentation" style="margin: 0 auto;">
                <tr>
                  <td><a href="#" style="color: #0A66C2; text-decoration: none; font-weight: 600;">Privacy Policy</a></td>
                  <td style="padding: 0 8px; color: #cbd5e0;">•</td>
                  <td><a href="#" style="color: #0A66C2; text-decoration: none; font-weight: 600;">Terms of Service</a></td>
                  <td style="padding: 0 8px; color: #cbd5e0;">•</td>
                  <td><a href="#" style="color: #0A66C2; text-decoration: none; font-weight: 600;">Contact Support</a></td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>"""

    # Replacements
    html_rendered = html_template.replace("{{owner_name}}", owner_name)\
                                 .replace("{{organization_name}}", organization_name)\
                                 .replace("{{tracking_purpose}}", tracking_purpose)\
                                 .replace("{{tracking_duration}}", duration)\
                                 .replace("{{requested_by}}", requested_by)\
                                 .replace("{{consent_expiry}}", consent_expiry)\
                                 .replace("{{registration_link}}", registration_link)\
                                 .replace("{{qrCodeImage}}", qr_image_src)
    
    return html_rendered


def send_html_email_via_smtp(to_email, subject, html_content):
    import smtplib
    from email.mime.multipart import MIMEMultipart
    from email.mime.text import MIMEText
    from email.mime.image import MIMEImage
    import re
    
    smtp_server = os.getenv('SMTP_SERVER')
    smtp_port = os.getenv('SMTP_PORT', '587')
    smtp_username = os.getenv('SMTP_USERNAME')
    smtp_password = os.getenv('SMTP_PASSWORD')
    smtp_from = os.getenv('SMTP_FROM', 'AegisTrack <godfrey.cs23@krct.ac.in>')
    
    if not smtp_server or not smtp_username or not smtp_password:
        return False, "SMTP server credentials not configured."
        
    try:
        msg = MIMEMultipart('related')  # Use 'related' to support inline attachments/CID
        msg['Subject'] = subject
        msg['From'] = smtp_from
        msg['To'] = to_email
        
        # Attach plain text fallback
        plain_text = (
            "AegisTrack - Device Monitoring Authorization Request\n\n"
            f"Hello, a tracking request has been submitted for your review.\n"
            "Tracking will only begin after your explicit approval."
        )
        
        msg_alternative = MIMEMultipart('alternative')
        msg.attach(msg_alternative)
        msg_alternative.attach(MIMEText(plain_text, 'plain'))
        
        # Find if there's a base64 image embedded in the HTML content that should be converted to CID attachment
        base64_pattern = r'src="data:image/png;base64,([^"]+)"'
        match = re.search(base64_pattern, html_content)
        
        if match:
            # We found a base64 encoded PNG. Let's convert it to a CID attachment!
            qr_b64_data = match.group(1)
            qr_bytes = base64.b64decode(qr_b64_data)
            
            # Replace the src attribute in the html content
            html_content_cid = re.sub(base64_pattern, 'src="cid:consent-qr"', html_content)
            msg_alternative.attach(MIMEText(html_content_cid, 'html'))
            
            # Create the MIMEImage and attach it
            mime_img = MIMEImage(qr_bytes, 'png')
            mime_img.add_header('Content-ID', '<consent-qr>')
            mime_img.add_header('Content-Disposition', 'inline', filename='consent-qr.png')
            msg.attach(mime_img)
        else:
            msg_alternative.attach(MIMEText(html_content, 'html'))
        
        # Dispatch
        server = smtplib.SMTP(smtp_server, int(smtp_port), timeout=15)
        server.ehlo()
        if smtp_port == '587':
            server.starttls()
            server.ehlo()
        server.login(smtp_username, smtp_password)
        server.sendmail(smtp_from, [to_email], msg.as_string())
        server.quit()
        return True, "Email successfully sent."
    except Exception as e:
        return False, str(e)


@app.route('/tracking-requests/<token>/send-email', methods=['POST'])
@operator_required()
def send_tracking_request_email(token):
    username = get_jwt_identity()
    request_doc = tracking_requests.find_one({'token': token})
    if not request_doc:
        return jsonify({'error': 'Tracking request not found'}), 404
        
    data = request.get_json() or {}
    to_email = data.get('notify_email') or request_doc.get('notify_email')
    
    if not to_email:
        return jsonify({'error': 'Recipient email address is required'}), 400
        
    html_content = render_html_email(request_doc)
    subject = "Action Required: Review Device Monitoring Request"
    
    smtp_server = os.getenv('SMTP_SERVER')
    smtp_username = os.getenv('SMTP_USERNAME')
    smtp_password = os.getenv('SMTP_PASSWORD')
    smtp_configured = bool(smtp_server and smtp_username and smtp_password)
    
    now = datetime.now(timezone.utc)
    if not smtp_configured:
        consent_audit_logs.insert_one({
            'event': 'EMAIL_SEND_FAILED',
            'performed_by': username,
            'details': {'token': token, 'recipient': to_email, 'reason': 'SMTP unconfigured'},
            'timestamp': now
        })
        return jsonify({
            'success': False,
            'error': 'SMTP is unconfigured',
            'msg': 'SMTP configurations are missing in your backend .env file. Direct email dispatch requires SMTP settings.',
            'html_preview': html_content
        }), 200
        
    success, message = send_html_email_via_smtp(to_email, subject, html_content)
    
    if success:
        tracking_requests.update_one({'token': token}, {'$set': {'status': 'EMAIL_OPENED'}})
        
        consent_audit_logs.insert_many([
            {
                'event': 'EMAIL_SENT',
                'performed_by': username,
                'details': {'token': token, 'recipient': to_email},
                'timestamp': now
            },
            {
                'event': 'EMAIL_OPENED',
                'performed_by': username,
                'details': {'token': token, 'recipient': to_email},
                'timestamp': now
            }
        ])
        
        vault_logs.insert_many([
            {
                'owner': username,
                'data': cipher.encrypt(json.dumps({'event': 'EMAIL_SENT', 'token': token, 'recipient': to_email}).encode()),
                'created_at': now,
                'encrypted': True
            },
            {
                'owner': username,
                'data': cipher.encrypt(json.dumps({'event': 'EMAIL_OPENED', 'token': token, 'recipient': to_email}).encode()),
                'created_at': now,
                'encrypted': True
            }
        ])
        
        return jsonify({
            'success': True,
            'message': 'Premium HTML Consent Email successfully sent.',
            'html_preview': html_content
        }), 200
    else:
        consent_audit_logs.insert_one({
            'event': 'EMAIL_SEND_FAILED',
            'performed_by': username,
            'details': {'token': token, 'recipient': to_email, 'reason': message},
            'timestamp': now
        })
        return jsonify({
            'success': False,
            'error': 'SMTP delivery failure',
            'msg': f"Failed to send email: {message}",
            'html_preview': html_content
        }), 500


@app.route('/tracking-requests', methods=['POST'])

@operator_required()
@limiter.limit('10 per hour')
def create_tracking_request():
    username = get_jwt_identity()
    data = request.get_json() or {}
    phone_number = data.get('phone_number')
    owner_name = data.get('owner_name')
    tracking_purpose = data.get('tracking_purpose')
    tracking_duration = data.get('tracking_duration')
    organization_name = data.get('organization_name')
    consent_expiry_date = data.get('consent_expiry_date')
    notify_email = data.get('notify_email')

    if not phone_number or not owner_name or not tracking_purpose:
        return jsonify({'error': 'phone_number, owner_name, and tracking_purpose are required'}), 400

    token = generate_secure_token()
    while tracking_requests.find_one({'token': token}):
        token = generate_secure_token()

    created_at = datetime.now(timezone.utc)
    expires_at = created_at + timedelta(hours=24)

    registration_url = f"{get_backend_url()}/register-device/{token}"

    # Generate QR Code image as base64 PNG
    qr_b64 = None
    try:
        qr = qrcode.make(registration_url)
        buf = io.BytesIO()
        qr.save(buf, format='PNG')
        qr_b64 = base64.b64encode(buf.getvalue()).decode()
    except Exception as e:
        print(f"QR code generation failed: {e}", flush=True)

    request_doc = {
        'phone_number': phone_number,
        'owner_name': owner_name,
        'tracking_purpose': tracking_purpose,
        'tracking_duration': tracking_duration,
        'organization_name': organization_name,
        'consent_expiry_date': consent_expiry_date,
        'notify_email': notify_email,
        'token': token,
        'registrationUrl': registration_url,
        'registration_url': registration_url,
        'qrGenerated': True if qr_b64 else False,
        'qrBase64': qr_b64,
        'qrImagePath': None,
        'status': 'LINK_GENERATED',
        'operator_id': username,
        'created_by': username,
        'created_at': created_at,
        'expires_at': expires_at,
        'sms_sent': False
    }
    tracking_requests.insert_one(request_doc)
    request_id = str(request_doc.get('_id'))

    print("REQUEST CREATED:", request_id, flush=True)
    print("TOKEN GENERATED:", token, flush=True)
    
    expiry_str = consent_expiry_date if consent_expiry_date else "Not specified"
    org_str = organization_name if organization_name else "An operator"
    
    # Build user-facing message (operator-facing preview)
    message_preview = (
        "AegisTrack\n\n"
        "Device Monitoring Consent Request\n\n"
        f"Hello {owner_name},\n\n"
        f"{org_str} has requested authorization to register and monitor a device associated with this mobile number.\n\n"
        f"Purpose: {tracking_purpose}\n"
        f"Duration: {tracking_duration} days\n\n"
        "Tracking will NOT begin unless you explicitly review and approve the request.\n\n"
        "To continue:\n\n"
        "• Open the registration link:\n"
        f"{registration_url}\n\n"
        "OR\n\n"
        "• Scan the QR code displayed below to access the consent portal.\n\n"
        "Inside the portal you can:\n"
        "✓ Review monitoring details\n"
        "✓ Read the privacy policy\n"
        "✓ Grant or deny consent\n"
        "✓ Register your device\n"
        "✓ Revoke authorization later if desired\n\n"
        f"This request expires on {expiry_str}.\n"
        "Note: The registration link is active for 7 minutes only.\n\n"
        "AegisTrack\n"
        "Consent-Based Device Enrollment System (CDEAS)"
    )

    # Alternatives to SMS: WhatsApp link, QR code (base64 PNG), and copyable link
    # Prepare WhatsApp link (wa.me) with encoded message body
    try:
        clean_phone = ''.join([c for c in phone_number if c.isdigit()])
        wa_text = quote_plus(message_preview)
        whatsapp_web_link = f"https://wa.me/{clean_phone}?text={wa_text}"
        whatsapp_app_link = f"whatsapp://send?phone={clean_phone}&text={wa_text}"
    except Exception:
        whatsapp_web_link = None
        whatsapp_app_link = None

    # Use pre-generated base64 QR code as data URI
    qr_data_uri = f"data:image/png;base64,{qr_b64}" if qr_b64 else None

    # Do not auto-send SMS by default; operator can choose an action in the UI
    sms_sent = False
    tracking_requests.update_one({'token': token}, {'$set': {'sms_sent': sms_sent}})

    # Log events to both collections as required
    consent_audit_logs.insert_many([
        {
            'event': 'TRACKING_REQUEST_CREATED',
            'performed_by': username,
            'details': {
                'target_phone': phone_number,
                'target_owner': owner_name,
                'token': token,
                'sms_sent': sms_sent,
                'whatsapp_link_available': bool(whatsapp_web_link or whatsapp_app_link),
                'qr_available': bool(qr_data_uri)
            },
            'timestamp': created_at
        },
        {
            'event': 'REQUEST_CREATED',
            'performed_by': username,
            'details': {'phone_number': phone_number, 'owner_name': owner_name, 'token': token},
            'timestamp': created_at
        },
        {
            'event': 'CONSENT_LINK_GENERATED',
            'performed_by': username,
            'details': {'registration_url': registration_url, 'token': token},
            'timestamp': created_at
        }
    ])

    vault_logs.insert_many([
        {
            'owner': username,
            'data': cipher.encrypt(json.dumps({'event': 'TRACKING_REQUEST_CREATED', 'target_phone': phone_number, 'created_by': username, 'token': token, 'preview': message_preview}).encode()),
            'created_at': created_at,
            'encrypted': True
        },
        {
            'owner': username,
            'data': cipher.encrypt(json.dumps({'event': 'REQUEST_CREATED', 'target_phone': phone_number, 'created_by': username, 'token': token}).encode()),
            'created_at': created_at,
            'encrypted': True
        },
        {
            'owner': username,
            'data': cipher.encrypt(json.dumps({'event': 'CONSENT_LINK_GENERATED', 'token': token, 'url': registration_url}).encode()),
            'created_at': created_at,
            'encrypted': True
        }
    ])

    # Mail links: operator notification address may be provided in request or via NOTIFY_EMAIL env
    operator_notify = data.get('notify_email') or os.getenv('NOTIFY_EMAIL') or ''
    try:
        subject = quote_plus(f"AegisTrack: Consent Request for {owner_name}")
        qr_code_url = f"http://{system_ip}:5000/tracking-requests/{token}/qr"
        body = quote_plus(message_preview + "\n\nScan QR Code to access:\n" + qr_code_url)
        mailto_link = f"mailto:{operator_notify}?subject={subject}&body={body}"
        gmail_compose_link = f"https://mail.google.com/mail/?view=cm&fs=1&to={operator_notify}&su={subject}&body={body}"
    except Exception:
        mailto_link = None
        gmail_compose_link = None

    return jsonify({
        'success': True,
        'delivery_mode': 'LINK',
        'message': 'Tracking request created',
        'token': token,
        'registration_url': registration_url,
        'registrationUrl': registration_url,
        'deliveryReady': True,
        'sms_sent': sms_sent,
        'message_preview': message_preview,
        'html_preview': render_html_email(request_doc),
        'smtp_configured': bool(os.getenv('SMTP_SERVER') and os.getenv('SMTP_USERNAME') and os.getenv('SMTP_PASSWORD')),
        'whatsapp_web_link': whatsapp_web_link,
        'whatsapp_app_link': whatsapp_app_link,
        'qr_code_data_uri': qr_data_uri,
        'copy_link': registration_url,
        'mailto_link': mailto_link,
        'gmail_compose_link': gmail_compose_link,
        'notify_email': notify_email
    }), 201



@app.route('/tracking-requests/<token>', methods=['GET'])
@limiter.exempt
def get_tracking_request(token):
    print("TOKEN VALIDATION:", token, flush=True)
    request_doc = tracking_requests.find_one({'token': token})
    if not request_doc:
        return jsonify({'error': 'Invalid or expired token'}), 404

    status = request_doc.get('status')
    if status == 'EXPIRED':
        return jsonify({'error': 'This registration link has expired'}), 410

    # Check if a device has already registered for this request
    registration = device_registrations.find_one({'request_token': token})
    if registration:
        return jsonify({
            'phone_number': request_doc.get('phone_number'),
            'owner_name': request_doc.get('owner_name'),
            'tracking_purpose': request_doc.get('tracking_purpose'),
            'tracking_duration': request_doc.get('tracking_duration'),
            'organization_name': request_doc.get('organization_name'),
            'consent_expiry_date': request_doc.get('consent_expiry_date'),
            'operator_id': request_doc.get('operator_id'),
            'status': status,
            'created_at': request_doc.get('created_at').isoformat() if isinstance(request_doc.get('created_at'), datetime) else request_doc.get('created_at'),
            'notify_email': request_doc.get('notify_email'),
            'completed': True,
            'device_id': registration.get('device_id'),
            'registered_at': registration.get('registered_at').isoformat() if isinstance(registration.get('registered_at'), datetime) else registration.get('registered_at'),
            'tracking_status': registration.get('tracking_status', 'ACTIVE')
        }), 200

    if status not in ('PENDING', 'LINK_GENERATED', 'LINK_COPIED', 'WHATSAPP_OPENED', 'EMAIL_OPENED'):
        return jsonify({'error': 'This tracking request is no longer available'}), 410

    expires_at = request_doc.get('expires_at')
    if expires_at and isinstance(expires_at, datetime):
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at < datetime.now(timezone.utc):
            tracking_requests.update_one({'_id': request_doc['_id']}, {'$set': {'status': 'EXPIRED'}})
            return jsonify({'error': 'This registration link has expired'}), 410

    return jsonify({
        'phone_number': request_doc.get('phone_number'),
        'owner_name': request_doc.get('owner_name'),
        'tracking_purpose': request_doc.get('tracking_purpose'),
        'tracking_duration': request_doc.get('tracking_duration'),
        'organization_name': request_doc.get('organization_name'),
        'consent_expiry_date': request_doc.get('consent_expiry_date'),
        'operator_id': request_doc.get('operator_id'),
        'status': request_doc.get('status'),
        'created_at': request_doc.get('created_at').isoformat() if isinstance(request_doc.get('created_at'), datetime) else request_doc.get('created_at'),
        'notify_email': request_doc.get('notify_email')
    }), 200


@app.route('/tracking-requests/<token>/status', methods=['POST'])
@operator_required()
def update_tracking_request_status(token):
    username = get_jwt_identity()
    data = request.get_json() or {}
    new_status = data.get('status')

    valid_statuses = [
        'PENDING', 'LINK_GENERATED', 'LINK_COPIED', 
        'WHATSAPP_OPENED', 'EMAIL_OPENED', 
        'CONSENT_GRANTED', 'DEVICE_REGISTERED', 'TRACKING_ACTIVE'
    ]
    if not new_status or new_status not in valid_statuses:
        return jsonify({'error': 'Invalid status'}), 400

    req_doc = tracking_requests.find_one({'token': token})
    if not req_doc:
        return jsonify({'error': 'Tracking request not found'}), 404

    # Allow operator to update status of their request
    if req_doc.get('operator_id') != username and req_doc.get('created_by') != username:
        return jsonify({'error': 'Unauthorized'}), 403

    tracking_requests.update_one({'token': token}, {'$set': {'status': new_status}})

    now = datetime.now(timezone.utc)
    # Log audit events
    consent_audit_logs.insert_one({
        'event': new_status,
        'performed_by': username,
        'details': {'token': token, 'status': new_status},
        'timestamp': now
    })

    vault_logs.insert_one({
        'owner': username,
        'data': cipher.encrypt(json.dumps({'event': new_status, 'token': token}).encode()),
        'created_at': now,
        'encrypted': True
    })

    return jsonify({'success': True, 'status': new_status}), 200


@app.route('/tracking-requests/<token>/qr', methods=['GET'])
def get_tracking_request_qr(token):
    request_doc = tracking_requests.find_one({'token': token})
    if not request_doc:
        return jsonify({'error': 'Invalid or unavailable token'}), 404

    registration_url = f"{get_backend_url()}/register-device/{token}"

    qr_img = qrcode.make(registration_url)
    buffer = io.BytesIO()
    qr_img.save(buffer, format='PNG')
    buffer.seek(0)

    return send_file(buffer, mimetype='image/png', download_name=f'tracking-request-{token}.png')


@app.route('/tracking-requests', methods=['GET'])
@operator_required()
def list_tracking_requests():
    username = get_jwt_identity()
    cursor = tracking_requests.find({'operator_id': username}, {'_id': 0}).sort('created_at', -1)
    requests_list = []
    for doc in cursor:
        requests_list.append({
            'phone_number': doc.get('phone_number'),
            'owner_name': doc.get('owner_name'),
            'tracking_purpose': doc.get('tracking_purpose'),
            'tracking_duration': doc.get('tracking_duration'),
            'organization_name': doc.get('organization_name'),
            'status': doc.get('status'),
            'token': doc.get('token'),
            'created_at': doc.get('created_at').isoformat(),
            'sms_sent': doc.get('sms_sent', False)
        })
    return jsonify({'requests': requests_list}), 200


@app.route('/register-device/<token>', methods=['GET'])
def register_device_redirect(token):
    return redirect(f"{get_frontend_url()}/enrollment/device-registration.html?token={token}")


@app.route('/device-registrations', methods=['POST', 'OPTIONS'])
def create_device_registration():
    if request.method == 'OPTIONS':
        return '', 200

    data = request.get_json() or {}
    token = data.get('token')
    device_name = data.get('device_name')
    device_model = data.get('device_model')
    operating_system = data.get('operating_system')
    device_id = data.get('device_identifier')
    contact_email = data.get('contact_email')
    owner_full_name = data.get('full_name')
    owner_mobile_number = data.get('mobile_number')
    owner_password = data.get('password')
    browser_info = data.get('browser_info')
    ip_address = request.remote_addr
    fingerprint = data.get('fingerprint')

    # Validate mandatory fields (owner must create account during registration)
    if not token or not device_name or not device_model or not operating_system or not device_id or not owner_full_name or not owner_mobile_number or not owner_password:
        return jsonify({'error': 'token, device_name, device_model, operating_system, device_identifier, full_name, mobile_number and password are required'}), 400

    print("TOKEN VALIDATION:", token, flush=True)

    tracking_request_doc = tracking_requests.find_one({'token': token})
    if not tracking_request_doc:
        return jsonify({'error': 'Invalid, completed, or expired tracking request'}), 404

    status = tracking_request_doc.get('status')
    if status == 'EXPIRED':
        return jsonify({'error': 'This tracking request has expired'}), 400
    if status not in ('PENDING', 'LINK_GENERATED', 'LINK_COPIED', 'WHATSAPP_OPENED', 'EMAIL_OPENED'):
        return jsonify({'error': 'This tracking request has already been completed or is no longer pending'}), 400

    expires_at = tracking_request_doc.get('expires_at')
    if expires_at and isinstance(expires_at, datetime):
        if expires_at.tzinfo is None:
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at < datetime.now(timezone.utc):
            tracking_requests.update_one({'_id': tracking_request_doc['_id']}, {'$set': {'status': 'EXPIRED'}})
            return jsonify({'error': 'This tracking request has expired'}), 400

    existing = device_registrations.find_one({'device_id': device_id})
    if existing:
        return jsonify({'error': 'Device is already registered with consent'}), 409

    # State transition: CONSENT_GRANTED
    tracking_requests.update_one({'token': token}, {'$set': {'status': 'CONSENT_GRANTED'}})

    # Prepare owner account (username derived from email if present, else mobile)
    owner_username = contact_email.strip() if contact_email else owner_mobile_number.strip()

    now = datetime.now(timezone.utc)

    existing_user = users.find_one({'username': owner_username})
    if existing_user and existing_user.get('role') != 'DEVICE_OWNER':
        return jsonify({'error': 'Owner identifier already reserved by another account type'}), 409
    if not existing_user:
        users.insert_one({
            'username': owner_username,
            'password': hash_password(owner_password),
            'role': 'DEVICE_OWNER',
            'owner_name': owner_full_name,
            'phone_number': owner_mobile_number,
            'email': contact_email,
            'device_id': device_id,
            'portal_access': True,
            'created_at': now
        })

    device_doc = {
        'device_id': device_id,
        'owner_name': tracking_request_doc.get('owner_name'),
        'owner_username': owner_username,
        'device_name': device_name,
        'device_model': device_model,
        'operating_system': operating_system,
        'contact_email': contact_email,
        'browser_info': browser_info,
        'ip_address': ip_address,
        'fingerprint': fingerprint,
        'consent_status': 'GRANTED',
        'tracking_status': 'REGISTERED',
        'registered_at': now,
        'request_token': token,
        'operator_id': tracking_request_doc.get('operator_id') or tracking_request_doc.get('created_by')
    }

    device_registrations.insert_one(device_doc)
    
    # State transition: DEVICE_REGISTERED
    tracking_requests.update_one({'token': token}, {'$set': {'status': 'DEVICE_REGISTERED'}})
    print("REGISTRATION SAVED:", device_id, flush=True)

    consent_audit_logs.insert_one({
        'event': 'CONSENT_GRANTED',
        'performed_by': tracking_request_doc.get('owner_name'),
        'details': {
            'device_id': device_id,
            'device_name': device_name,
            'token': token
        },
        'timestamp': now
    })

    vault_logs.insert_one({
        'owner': tracking_request_doc.get('owner_name'),
        'data': cipher.encrypt(json.dumps({'event': 'CONSENT_GRANTED', 'device_id': device_id, 'token': token}).encode()),
        'created_at': now,
        'encrypted': True
    })

    # Upsert into `devices` collection so operator dashboard can see the active device
    try:
        devices.update_one(
            {'device_id': device_id},
            {'$set': {
                'device_name': device_name,
                'device_model': device_model,
                'operating_system': operating_system,
                'owner': tracking_request_doc.get('operator_id'),
                'owner_username': owner_username,
                'latitude': None,
                'longitude': None,
                'accuracy': None,
                'timestamp': None,
                'last_updated': now,
                'tracking_status': 'ACTIVE'
            },
            '$setOnInsert': {
                'api_key': generate_api_key(),
                'created_at': now
            }},
            upsert=True
        )
    except Exception:
        pass

    # State transition: DEVICE_REGISTERED
    tracking_requests.update_one({'token': token}, {'$set': {'status': 'DEVICE_REGISTERED'}})
    print("TRACKING REGISTRATION COMPLETED (Awaiting location):", device_id, flush=True)

    return jsonify({
        'message': 'Consent granted and device registered',
        'tracking_status': 'REGISTERED',
        'consent_status': 'GRANTED',
        'registered_at': now.isoformat(),
        'device_id': device_id,
        'owner_username': owner_username
    }), 201


@app.route('/device-registrations', methods=['GET'])
@operator_required()
def list_device_registrations():
    username = get_jwt_identity()
    cursor = device_registrations.find({'operator_id': username}, {'_id': 0}).sort('registered_at', -1)
    regs = []
    for doc in cursor:
        reg = to_json(doc)
        # Enrich with live location data from devices collection
        device_id = doc.get('device_id')
        if device_id:
            live = devices.find_one({'device_id': device_id}, {'_id': 0, 'latitude': 1, 'longitude': 1, 'accuracy': 1, 'timestamp': 1, 'last_updated': 1, 'tracking_status': 1})
            if live:
                reg['latitude'] = live.get('latitude')
                reg['longitude'] = live.get('longitude')
                reg['accuracy'] = live.get('accuracy')
                reg['last_location_timestamp'] = live.get('timestamp')
                reg['last_updated'] = live.get('last_updated').isoformat() if isinstance(live.get('last_updated'), datetime) else live.get('last_updated')
                if live.get('tracking_status'):
                    reg['tracking_status'] = live.get('tracking_status')
        regs.append(reg)
    return jsonify({'registrations': regs}), 200


@app.route('/audit/logs', methods=['GET'])
@operator_required()
def get_audit_logs():
    cursor = consent_audit_logs.find({}, {'_id': 0}).sort('timestamp', -1).limit(200)
    logs = [to_json(doc) for doc in cursor]
    return jsonify({'logs': logs}), 200


@app.route('/operators', methods=['GET'])
@operator_required()
def list_operators():
    cursor = users.find({'role': 'OPERATOR'}, {'_id': 0, 'username': 1, 'owner_name': 1, 'created_at': 1})
    ops = [to_json(doc) for doc in cursor]
    return jsonify({'operators': ops}), 200


@app.route('/consent/revoke', methods=['POST', 'OPTIONS'])
def revoke_consent():
    if request.method == 'OPTIONS':
        return '', 200
    data = request.get_json() or {}
    device_id = data.get('device_id')
    token = data.get('token')

    query = {}
    if device_id:
        query['device_id'] = device_id
    elif token:
        query['request_token'] = token
    else:
        return jsonify({'error': 'device_id or token is required to revoke consent'}), 400

    registration = device_registrations.find_one(query)
    if not registration:
        return jsonify({'error': 'Registered device not found'}), 404

    now = datetime.now(timezone.utc)
    device_registrations.update_one({'_id': registration['_id']}, {'$set': {'tracking_status': 'REVOKED', 'consent_status': 'REVOKED', 'revoked_at': now}})
    tracking_requests.update_one({'token': registration.get('request_token')}, {'$set': {'status': 'REVOKED'}})

    consent_audit_logs.insert_one({
        'event': 'CONSENT_REVOKED',
        'performed_by': registration.get('owner_name'),
        'details': {
            'device_id': registration.get('device_id'),
            'request_token': registration.get('request_token')
        },
        'timestamp': now
    })

    vault_logs.insert_one({
        'owner': registration.get('owner_name'),
        'data': cipher.encrypt(json.dumps({'event': 'CONSENT_REVOKED', 'device_id': registration.get('device_id')}).encode()),
        'created_at': now,
        'encrypted': True
    })

    return jsonify({'message': 'Tracking authorization withdrawn', 'tracking_status': 'REVOKED'}), 200


@app.route('/device-location', methods=['POST', 'OPTIONS'])
def receive_device_location():
    """
    Public endpoint called by the enrolled device's browser after consent.
    Authenticates via device_id + registration token (no JWT required).
    Stores location, evaluates geofence, and broadcasts real-time events.
    """
    if request.method == 'OPTIONS':
        return '', 200

    data = request.get_json() or {}
    device_id = data.get('device_id')
    token = data.get('token')
    latitude = data.get('latitude')
    longitude = data.get('longitude')
    accuracy = data.get('accuracy')
    timestamp = data.get('timestamp')
    altitude = data.get('altitude')
    speed = data.get('speed')
    heading = data.get('heading')

    # Validate required fields
    if not device_id or not token:
        return jsonify({'error': 'device_id and token are required'}), 400
    if latitude is None or longitude is None:
        return jsonify({'error': 'latitude and longitude are required'}), 400

    try:
        lat = float(latitude)
        lon = float(longitude)
    except (ValueError, TypeError):
        return jsonify({'error': 'Invalid latitude/longitude numeric value'}), 400

    if lat == 0.0 and lon == 0.0:
        return jsonify({'error': 'Coordinates (0, 0) are invalid and rejected'}), 400

    # Authenticate: verify this device_id was registered with this token
    registration = device_registrations.find_one({
        'device_id': device_id,
        'request_token': token
    })
    if not registration:
        return jsonify({'error': 'Invalid device_id or token — device not enrolled'}), 403

    if registration.get('consent_status') == 'REVOKED':
        return jsonify({'error': 'Consent has been revoked — tracking inactive'}), 403
    if registration.get('tracking_status') in ('PAUSED', 'DISABLED'):
        return jsonify({'error': 'Tracking has been paused or disabled by owner — telemetry rejected'}), 403

    now = datetime.now(timezone.utc)
    acc = float(accuracy) if accuracy is not None else None
    alt = float(altitude) if altitude is not None else None
    spd = float(speed) if speed is not None else None
    hdg = float(heading) if heading is not None else None
    ts = timestamp or now.isoformat()

    # Persist location record
    location_doc = {
        'device_id': device_id,
        'latitude': lat,
        'longitude': lon,
        'accuracy': acc,
        'altitude': alt,
        'speed': spd,
        'heading': hdg,
        'timestamp': ts,
        'created_at': now,
        'source': 'device_portal'
    }
    locations.insert_one(location_doc)

    # Update device document with latest position
    operator_id = registration.get('operator_id')
    devices.update_one(
        {'device_id': device_id},
        {'$set': {
            'latitude': lat,
            'longitude': lon,
            'accuracy': acc,
            'altitude': alt,
            'speed': spd,
            'heading': hdg,
            'timestamp': ts,
            'last_updated': now,
            'tracking_status': 'TRACKING_ACTIVE'
        }},
        upsert=True
    )

    # Update device_registrations tracking_status
    device_registrations.update_one(
        {'device_id': device_id},
        {'$set': {'tracking_status': 'TRACKING_ACTIVE', 'last_location_at': now}}
    )

    # Update tracking request status to TRACKING_ACTIVE
    tracking_requests.update_one(
        {'token': token},
        {'$set': {'status': 'TRACKING_ACTIVE'}}
    )

    # Geofence evaluation using existing haversine()
    alert_payload = None
    geofence = geofences.find_one({'device_id': device_id})
    if geofence:
        distance = haversine(lat, lon, geofence['center_lat'], geofence['center_lng'])
        inside = distance <= geofence['radius_meters']

        if not inside and geofence.get('is_inside', True):
            # Geofence breach — device moved outside perimeter
            alert_payload = {
                'event': 'GEOFENCE_BREACH',
                'device_id': device_id,
                'latitude': lat,
                'longitude': lon,
                'accuracy': acc,
                'distance_meters': round(distance, 1),
                'radius_meters': geofence['radius_meters'],
                'center_lat': geofence['center_lat'],
                'center_lng': geofence['center_lng'],
                'timestamp': ts
            }
            geofences.update_one({'device_id': device_id}, {'$set': {'is_inside': False}})
            alerts.insert_one({
                'device_id': device_id,
                'type': 'GEOFENCE_BREACH',
                'message': f'Digital Perimeter Breach: {round(distance, 1)}m from center (radius {geofence["radius_meters"]}m)',
                'latitude': lat,
                'longitude': lon,
                'timestamp': ts,
                'created_at': now
            })
            # Audit log for breach
            consent_audit_logs.insert_one({
                'event': 'GEOFENCE_BREACH',
                'performed_by': registration.get('owner_name', 'device'),
                'details': {'device_id': device_id, 'distance_meters': round(distance, 1), 'timestamp': ts},
                'timestamp': now
            })
        elif inside and not geofence.get('is_inside', True):
            geofences.update_one({'device_id': device_id}, {'$set': {'is_inside': True}})

    # Broadcast location update to operator WebSocket
    ws_payload = {
        'device_id': device_id,
        'latitude': lat,
        'longitude': lon,
        'accuracy': acc,
        'timestamp': ts,
        'tracking_status': 'TRACKING_ACTIVE'
    }
    owner_username = registration.get('owner_username')
    broadcast('location_updated', ws_payload, owner=operator_id)
    if owner_username:
        broadcast('location_updated', ws_payload, owner=owner_username)
    if alert_payload:
        broadcast('geofence_alert', alert_payload, owner=operator_id)
        if owner_username:
            broadcast('geofence_alert', alert_payload, owner=owner_username)

    return jsonify({
        'message': 'Location received and persisted',
        'device_id': device_id,
        'latitude': lat,
        'longitude': lon,
        'accuracy': acc,
        'timestamp': ts,
        'geofence_breach': alert_payload is not None
    }), 200


@app.route('/device-location/<device_id>', methods=['GET', 'OPTIONS'])
def get_device_location_public(device_id):
    """
    Public lightweight endpoint for the device portal to fetch its own last known location.
    Also returns force-location signal and configurable update interval.
    Requires token query param for auth.
    """
    if request.method == 'OPTIONS':
        return '', 200
    token = request.args.get('token')
    if not token:
        return jsonify({'error': 'token query param required'}), 400
    registration = device_registrations.find_one({'device_id': device_id, 'request_token': token})
    if not registration:
        return jsonify({'error': 'Not found'}), 404
    device = devices.find_one({'device_id': device_id}, {'_id': 0})
    if not device:
        return jsonify({'error': 'Device record not found'}), 404
    return jsonify({
        'device_id': device_id,
        'latitude': device.get('latitude'),
        'longitude': device.get('longitude'),
        'accuracy': device.get('accuracy'),
        'timestamp': device.get('timestamp'),
        'last_updated': device.get('last_updated').isoformat() if isinstance(device.get('last_updated'), datetime) else device.get('last_updated'),
        'tracking_status': device.get('tracking_status', 'REGISTERED')
    }), 200


@app.route('/device-location/<device_id>/force-check', methods=['GET', 'OPTIONS'])
def force_location_check(device_id):
    """
    Device polls this endpoint (~every 60s) to check if the operator has requested
    a forced location update or changed the update interval.
    Requires token query param for auth.
    """
    if request.method == 'OPTIONS':
        return '', 200
    token = request.args.get('token')
    if not token:
        return jsonify({'error': 'token query param required'}), 400
    registration = device_registrations.find_one({'device_id': device_id, 'request_token': token})
    if not registration:
        return jsonify({'error': 'Not found'}), 404
    if registration.get('consent_status') == 'REVOKED':
        return jsonify({'force': False, 'revoked': True}), 200

    force_entry = force_location_requests.find_one_and_delete({'device_id': device_id})
    interval_ms = None
    if force_entry:
        interval_ms = force_entry.get('interval_ms')

    return jsonify({
        'force': bool(force_entry),
        'interval_ms': interval_ms,
        'revoked': False
    }), 200


@app.route('/tracking-requests/<token>/force-location', methods=['POST', 'OPTIONS'])
@operator_required()
def request_force_location(token):
    """
    Operator-triggered: signal the enrolled device to send a fresh GPS reading immediately.
    Optionally includes a new update interval_ms.
    """
    if request.method == 'OPTIONS':
        return '', 200
    username = get_jwt_identity()
    req_doc = tracking_requests.find_one({'token': token})
    if not req_doc:
        return jsonify({'error': 'Tracking request not found'}), 404
    if req_doc.get('operator_id') != username and req_doc.get('created_by') != username:
        return jsonify({'error': 'Unauthorized'}), 403

    # Find the device registered against this token
    reg = device_registrations.find_one({'request_token': token})
    if not reg:
        return jsonify({'error': 'No enrolled device for this token'}), 404

    device_id = reg.get('device_id')
    data = request.get_json() or {}
    interval_ms = data.get('interval_ms')  # optional: change update interval

    force_location_requests.update_one(
        {'device_id': device_id},
        {'$set': {
            'requested_at': datetime.now(timezone.utc).isoformat(),
            'requested_by': username,
            'interval_ms': interval_ms
        }},
        upsert=True
    )

    now = datetime.now(timezone.utc)
    consent_audit_logs.insert_one({
        'event': 'FORCE_LOCATION_REQUESTED',
        'performed_by': username,
        'details': {'device_id': device_id, 'token': token, 'interval_ms': interval_ms},
        'timestamp': now
    })
    return jsonify({
        'success': True,
        'message': 'Force location signal queued. Device will respond on next poll (~60s).',
        'device_id': device_id
    }), 200


@app.route('/devices/monitored', methods=['GET'])
@operator_required()
def list_monitored_devices():
    """
    Returns all consent-enrolled devices for the operator, enriched with:
    - Live location (lat/lng/accuracy/timestamp)
    - Tracking status
    - Geofence state (inside/outside, center, radius)
    - Recent alert count
    - Registration metadata
    """
    username = get_jwt_identity()
    cursor = device_registrations.find({'operator_id': username}, {'_id': 0}).sort('registered_at', -1)
    result = []
    for doc in cursor:
        device_id = doc.get('device_id')
        reg = to_json(doc)

        # Live location from devices collection
        live = devices.find_one({'device_id': device_id}, {'_id': 0}) if device_id else None
        if live:
            reg['latitude'] = live.get('latitude')
            reg['longitude'] = live.get('longitude')
            reg['accuracy'] = live.get('accuracy')
            reg['location_timestamp'] = live.get('timestamp')
            reg['last_updated'] = live.get('last_updated').isoformat() if isinstance(live.get('last_updated'), datetime) else live.get('last_updated')
            reg['tracking_status'] = live.get('tracking_status', doc.get('tracking_status', 'REGISTERED'))

        # Geofence state
        gf = geofences.find_one({'device_id': device_id}, {'_id': 0}) if device_id else None
        if gf:
            reg['geofence'] = {
                'center_lat': gf.get('center_lat'),
                'center_lng': gf.get('center_lng'),
                'radius_meters': gf.get('radius_meters'),
                'is_inside': gf.get('is_inside', True)
            }
        else:
            reg['geofence'] = None

        # Recent alert count (last 24h)
        since = datetime.now(timezone.utc) - timedelta(hours=24)
        reg['alert_count_24h'] = alerts.count_documents({
            'device_id': device_id,
            'created_at': {'$gte': since}
        }) if device_id else 0

        # Request token for force-location calls
        reg['request_token'] = doc.get('request_token')

        result.append(reg)
    return jsonify({'devices': result}), 200


@app.route('/devices/<device_id>/locations', methods=['GET'])
@operator_required()
def get_device_location_history(device_id):
    """
    Returns last N location records for a device (for path rendering on map).
    Requires operator ownership.
    """
    username = get_jwt_identity()
    device = devices.find_one({'device_id': device_id})
    # Check ownership via devices collection or device_registrations
    reg = device_registrations.find_one({'device_id': device_id, 'operator_id': username})
    if not reg and (not device or device.get('owner') != username):
        return jsonify({'error': 'Device not found or unauthorized'}), 404

    limit = min(int(request.args.get('limit', 50)), 200)
    cursor = locations.find(
        {'device_id': device_id},
        {'_id': 0, 'latitude': 1, 'longitude': 1, 'accuracy': 1, 'timestamp': 1, 'created_at': 1}
    ).sort('created_at', -1).limit(limit)
    history = list(cursor)
    # Reverse so oldest-first for path drawing
    history.reverse()
    return jsonify({'device_id': device_id, 'locations': [to_json(loc) for loc in history]}), 200


@app.route('/location', methods=['POST'])
@operator_required()
def receive_location():
    username = get_jwt_identity()
    data = request.get_json() or {}
    api_key = request.headers.get(API_KEY_HEADER)

    required_fields = ['device_id', 'latitude', 'longitude', 'accuracy', 'timestamp']
    missing = [field for field in required_fields if field not in data]
    if missing:
        return jsonify({'error': f'Missing required fields: {", ".join(missing)}'}), 400

    device_id = data.get('device_id')
    
    # CYBERSECURITY: Unauthorized device check
    if device_id != 'COMMAND_CONSOLE' and not verify_device_for_user(device_id, api_key, username):
        vault_logs.insert_one({
            'owner': username,
            'data': cipher.encrypt(json.dumps({'event': 'UNAUTHORIZED_NODE_INGEST', 'node': device_id, 'ip': request.remote_addr}).encode()),
            'created_at': datetime.now(timezone.utc),
            'encrypted': True
        })
        return jsonify({'error': 'Unauthorized device or API key'}), 403

    # CYBERSECURITY: Anomaly/Threat Detection (Impossible Travel)
    last_loc = locations.find_one({'device_id': device_id}, sort=[('timestamp', -1)])
    if last_loc:
        dist = haversine(float(data['latitude']), float(data['longitude']), last_loc['latitude'], last_loc['longitude'])
        # If speed > 500m/s (approx Mach 1.5), flag as threat
        try:
            t1 = datetime.fromisoformat(data['timestamp'].replace('Z', ''))
            t2 = last_loc['created_at']
            time_diff = abs((t1 - t2).total_seconds())
            if time_diff > 0 and (dist / time_diff) > 500:
                vault_threats.insert_one({
                    'owner': username,
                    'data': cipher.encrypt(json.dumps({
                        'event': 'IMPOSSIBLE_TRAVEL_DETECTED',
                        'node': device_id,
                        'speed': round(dist/time_diff, 2),
                        'ip': request.remote_addr
                    }).encode()),
                    'created_at': datetime.now(timezone.utc),
                    'encrypted': True
                })
                broadcast('security_threat', {'type': 'IMPOSSIBLE_TRAVEL', 'node': device_id}, owner=username)
        except: pass

    location_doc = {
        'device_id': device_id,
        'latitude': float(data['latitude']),
        'longitude': float(data['longitude']),
        'accuracy': float(data['accuracy']),
        'timestamp': data['timestamp'],
        'created_at': datetime.now(timezone.utc)
    }
    locations.insert_one(location_doc)

    latest_fields = {
        'latitude': location_doc['latitude'],
        'longitude': location_doc['longitude'],
        'accuracy': location_doc['accuracy'],
        'timestamp': location_doc['timestamp'],
        'last_updated': datetime.now(timezone.utc)
    }
    devices.update_one({'device_id': device_id}, {'$set': latest_fields})

    geofence = geofences.find_one({'device_id': device_id})
    alert_payload = None
    if geofence:
        distance = haversine(location_doc['latitude'], location_doc['longitude'], geofence['center_lat'], geofence['center_lng'])
        inside = distance <= geofence['radius_meters']
        if not inside and geofence.get('is_inside', True):
            alert_payload = {
                'device_id': device_id,
                'event': 'geofence_exit',
                'distance_meters': round(distance, 1),
                'center_lat': geofence['center_lat'],
                'center_lng': geofence['center_lng'],
                'radius_meters': geofence['radius_meters'],
                'timestamp': datetime.utcnow().isoformat()
            }
            geofences.update_one({'device_id': device_id}, {'$set': {'is_inside': False}})
            alerts.insert_one({
                'device_id': device_id,
                'type': 'geofence_exit',
                'message': f'Digital Perimeter Breach Detected ({round(distance,1)}m deviation)',
                'created_at': datetime.now(timezone.utc)
            })
        elif inside and not geofence.get('is_inside', True):
            geofences.update_one({'device_id': device_id}, {'$set': {'is_inside': True}})

    payload = {
        'device_id': device_id,
        'latitude': location_doc['latitude'],
        'longitude': location_doc['longitude'],
        'accuracy': location_doc['accuracy'],
        'timestamp': location_doc['timestamp']
    }
    broadcast('location_updated', payload, owner=username)
    if alert_payload:
        broadcast('geofence_alert', alert_payload, owner=username)

    return jsonify({'message': 'Telemetry packet ingested and verified', 'device_id': device_id}), 200


@app.route('/location/<device_id>', methods=['GET', 'OPTIONS'])
@operator_required()
@limiter.exempt
def get_location(device_id):
    # Guard: reject sentinel/placeholder IDs
    if not device_id or device_id in ('none', 'null', 'undefined', 'NONE'):
        return jsonify({'error': 'Invalid device_id'}), 400
    username = get_jwt_identity()
    device = devices.find_one({'device_id': device_id})
    if not device or device.get('owner') != username:
        return jsonify({'error': 'Device not found or unauthorized'}), 404
    return jsonify(to_json(device)), 200


@app.route('/geofence', methods=['POST'])
@operator_required()
def set_geofence():
    username = get_jwt_identity()
    data = request.get_json() or {}
    required_fields = ['device_id', 'center_lat', 'center_lng', 'radius_meters']
    missing = [field for field in required_fields if field not in data]
    if missing:
        return jsonify({'error': f'Missing required fields: {", ".join(missing)}'}), 400

    device_id = data['device_id']
    device = devices.find_one({'device_id': device_id})
    if not device or device.get('owner') != username:
        return jsonify({'error': 'Device not found or unauthorized'}), 404

    geofences.update_one(
        {'device_id': device_id},
        {'$set': {
            'device_id': device_id,
            'center_lat': float(data['center_lat']),
            'center_lng': float(data['center_lng']),
            'radius_meters': float(data['radius_meters']),
            'is_inside': True,
            'created_at': datetime.now(timezone.utc)
        }},
        upsert=True
    )

    return jsonify({'message': 'Digital perimeter established and armed', 'device_id': device_id}), 200


@app.route('/geofence/<device_id>', methods=['GET'])
@operator_required()
def get_geofence(device_id):
    username = get_jwt_identity()
    device = devices.find_one({'device_id': device_id})
    if not device or device.get('owner') != username:
        return jsonify({'error': 'Device not found or unauthorized'}), 404

    geofence = geofences.find_one({'device_id': device_id})
    return jsonify(to_json(geofence)), 200


@app.route('/alerts', methods=['GET'])
@operator_required()
def get_alerts():
    username = get_jwt_identity()
    user_devices = [device['device_id'] for device in devices.find({'owner': username}, {'device_id': 1})]
    alert_cursor = alerts.find({'device_id': {'$in': user_devices}}, {'_id': 0}).sort('created_at', -1).limit(50)
    return jsonify({'alerts': [to_json(alert) for alert in alert_cursor]}), 200


@app.route('/vault/<module>', methods=['POST'])
@operator_required()
def save_vault_data(module):
    username = get_jwt_identity()
    data = request.get_json() or {}
    
    collection_map = {
        'analytics': vault_analytics,
        'threats': vault_threats,
        'logs': vault_logs,
        'files': vault_files,
        'operators': vault_operators,
        'config': vault_config
    }
    
    if module not in collection_map:
        return jsonify({'error': f'Invalid module: {module}'}), 400
        
    collection = collection_map[module]
    
    # CYBERSECURITY: Symmetric Encryption of data at rest
    encrypted_data = cipher.encrypt(json.dumps(data).encode())
    
    doc = {
        'owner': username,
        'data': encrypted_data,
        'encrypted': True,
        'created_at': datetime.now(timezone.utc)
    }
    
    collection.insert_one(doc)
    return jsonify({'message': f'Segmented vault persistence successful: {module}'}), 201


@app.route('/vault/<module>', methods=['GET'])
@operator_required()
def get_vault_data(module):
    username = get_jwt_identity()
    
    collection_map = {
        'analytics': vault_analytics,
        'threats': vault_threats,
        'logs': vault_logs,
        'files': vault_files,
        'operators': vault_operators,
        'config': vault_config
    }
    
    if module not in collection_map:
        return jsonify({'error': f'Invalid module: {module}'}), 400
        
    collection = collection_map[module]
    cursor = collection.find({'owner': username}, {'_id': 0}).sort('created_at', -1).limit(100)
    
    results = []
    for doc in cursor:
        clean_doc = to_json(doc)
        # CYBERSECURITY: On-the-fly Decryption
        if doc.get('encrypted'):
            try:
                decrypted_bytes = cipher.decrypt(doc['data'])
                clean_doc['data'] = json.loads(decrypted_bytes.decode())
            except Exception as e:
                clean_doc['data'] = {"error": "Decryption failed", "details": str(e)}
        results.append(clean_doc)
    
    return jsonify({module: results}), 200


@app.route('/proxy/groq', methods=['POST'])
@operator_required()
def proxy_groq():
    """
    Proxy request to Groq API to keep the API Key secure on the server.
    """
    groq_api_key = os.getenv('GROQ_API_KEY')
    if not groq_api_key:
        return jsonify({'error': 'GROQ_API_KEY not configured on server'}), 500

    data = request.get_json()
    try:
        response = requests.post(
            'https://api.groq.com/openai/v1/chat/completions',
            headers={
                'Content-Type': 'application/json',
                'Authorization': f'Bearer {groq_api_key}'
            },
            json=data,
            timeout=30
        )
        return jsonify(response.json()), response.status_code
    except Exception as e:
        return jsonify({'error': str(e)}), 500


@sock.route('/ws')
def websocket(ws):
    client_info = None
    try:
        token = request.args.get('token')
        username = user_from_token(token)
        if not username:
            try:
                ws.send(json.dumps({'event': 'error', 'payload': {'message': 'Invalid or missing token'}}))
            except Exception:
                pass
            return

        client_info = {'sock': ws, 'user': username}
        active_sockets.append(client_info)

        while True:
            try:
                message = ws.receive(timeout=30)
            except Exception:
                # Connection reset, timeout, or binary frame — clean disconnect
                break

            if message is None:
                break

            # Ignore non-string frames (binary pings from browsers)
            if not isinstance(message, str):
                continue

            try:
                incoming = json.loads(message)
                if incoming.get('type') == 'ping':
                    ws.send(json.dumps({
                        'event': 'pong',
                        'payload': {'timestamp': datetime.now(timezone.utc).isoformat()}
                    }))
            except (json.JSONDecodeError, Exception):
                continue

    except Exception as e:
        print(f"WebSocket session exception: {e}", flush=True)
    finally:
        if client_info and client_info in active_sockets:
            active_sockets.remove(client_info)


@app.route('/health', methods=['GET'])
def health_check():
    return jsonify({'status': 'healthy', 'timestamp': datetime.now(timezone.utc).isoformat()}), 200


if __name__ == '__main__':
    ssl_cert = os.getenv('SSL_CERT_PATH')
    ssl_key = os.getenv('SSL_KEY_PATH')
    print('INITIALIZING AegisTrack CYBERSECURITY KERNEL...')
    print('SECURE API ENDPOINTS ACTIVE:')
    print('POST /auth/register - Operator Provisioning')
    print('POST /auth/login - C2 Access Grant')
    print('POST /devices/register - Node Ingest Key Provisioning')
    print('POST /location - Telemetry Packet Ingestion')
    print('GET /location/<device_id> - Singular Node Status')
    print('GET /devices - Global Node Inventory')
    print('POST /geofence - Perimeter Configuration')
    print('GET /alerts - Threat Incident Retrieval')
    print('GET /health - Integrity Check')
    if ssl_cert and ssl_key:
        print('Running with HTTPS Hardening')
        app.run(host='0.0.0.0', port=5000, debug=True, ssl_context=(ssl_cert, ssl_key))
    else:
        app.run(host='0.0.0.0', port=5000, debug=True)

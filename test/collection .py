import os
import json
from pymongo import MongoClient
from dotenv import load_dotenv
from datetime import datetime

load_dotenv(dotenv_path='backend/.env')
MONGODB_URI = os.getenv('MONGODB_URI')

def json_serial(obj):
    if isinstance(obj, datetime): return obj.isoformat()
    return str(obj)

try:
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
    db = client['aegistrack']
    collections = [
        'users', 'devices', 'locations', 'geofences', 'alerts',
        'vault_analytics', 'vault_threats', 'vault_logs', 
        'vault_files', 'vault_operators', 'vault_config'
    ]
    
    print("="*60)
    print(f"AegisTrack DATABASE SUMMARY - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("="*60)

    for collection_name in collections:
        count = db[collection_name].count_documents({})
        print(f"COLLECTION: {collection_name.upper():<20} | COUNT: {count}")
        
except Exception as e: print(e)
finally: client.close()

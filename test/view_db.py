import os
import json
from pymongo import MongoClient
from dotenv import load_dotenv
from datetime import datetime

# Load environment variables
load_dotenv(dotenv_path='backend/.env')

MONGODB_URI = os.getenv('MONGODB_URI')

if not MONGODB_URI:
    print("Error: MONGODB_URI not found in .env file.")
    exit(1)

def json_serial(obj):
    """JSON serializer for objects not serializable by default json code"""
    if isinstance(obj, datetime):
        return obj.isoformat()
    return str(obj)

try:
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
    db = client['gps_tracking']
    
    # List of all collections to inspect
    collections = [
        'users', 'devices', 'locations', 'geofences', 'alerts',
        'vault_analytics', 'vault_threats', 'vault_logs', 
        'vault_files', 'vault_operators', 'vault_config'
    ]
    
    print("="*60)
    print(f"MTS DATABASE EXPLORER - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("="*60)

    for collection_name in collections:
        count = db[collection_name].count_documents({})
        print(f"\n[ COLLECTION: {collection_name.upper()} ] - {count} records")
        print("-" * 60)
        
        if count == 0:
            print("  (Empty)")
        else:
            # Show last 5 documents for each collection
            cursor = db[collection_name].find().sort('_id', -1).limit(5)
            for doc in cursor:
                # Remove _id for cleaner printing
                if '_id' in doc:
                    del doc['_id']
                print(json.dumps(doc, indent=2, default=json_serial))
                print("  " + "." * 30)
                
    print("\n" + "="*60)
    print("END OF DATA STREAM")
    print("="*60)

except Exception as e:
    print(f"An error occurred: {e}")
finally:
    client.close()

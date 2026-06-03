import os
from pymongo import MongoClient
from dotenv import load_dotenv

# Load environment variables
load_dotenv(dotenv_path='backend/.env')

MONGODB_URI = os.getenv('MONGODB_URI')

if not MONGODB_URI:
    print("Error: MONGODB_URI not found in .env file.")
    exit(1)

try:
    client = MongoClient(MONGODB_URI, serverSelectionTimeoutMS=5000)
    db = client['gps_tracking']
    
    # Get all collections present in the database, excluding system collections
    db_collections = db.list_collection_names()
    db_collections = [c for c in db_collections if not c.startswith('system.')]
    
    # Explicit list of all known collections to ensure we cover them all
    defined_collections = [
        'users', 'devices', 'locations', 'geofences', 'alerts',
        'vault_analytics', 'vault_threats', 'vault_logs', 
        'vault_files', 'vault_operators', 'vault_config'
    ]
    
    # Merge and sort the collections
    collections = sorted(list(set(db_collections + defined_collections)))
    
    for collection_name in collections:
        result = db[collection_name].delete_many({})
        print(f"Deleted {result.deleted_count} documents from '{collection_name}' collection.")
        
    print("\nDatabase cleared successfully.")

except Exception as e:
    print(f"An error occurred: {e}")
finally:
    client.close()


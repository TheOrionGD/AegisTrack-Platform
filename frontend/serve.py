import sys
import os
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

if __name__ == '__main__':
    # Change directory to the script's directory so it serves the frontend assets correctly
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)
    
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"Starting multi-threaded AegisTrack Frontend Server on port {port}...")
    
    server = ThreadingHTTPServer(('0.0.0.0', port), SimpleHTTPRequestHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopping frontend server.")

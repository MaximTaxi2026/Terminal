import urllib.request
import json

url = "http://127.0.0.1:8000/api/message"
data = {
    "nickname": "TestUser",
    "color": "#00FF41",
    "text": "Hello, world!",
    "image": "",
    "client_id": "device_test_123456",
    "token": "092026"
}

req = urllib.request.Request(
    url, 
    data=json.dumps(data).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="POST"
)

try:
    with urllib.request.urlopen(req) as res:
        print("Status:", res.status)
        print("Body:", res.read().decode("utf-8"))
except urllib.error.HTTPError as e:
    print("HTTP Error:", e.code)
    print("Body:", e.read().decode("utf-8"))
except Exception as e:
    print("Error:", e)

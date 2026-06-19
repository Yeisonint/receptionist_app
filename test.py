import urllib.request, json

KEY = "AIzaSyD3L8PGOJfwvLkzKa5XIF5VHyVEz2-9xhU"

for version in ["v1alpha", "v1beta", "v1"]:
    url = f"https://generativelanguage.googleapis.com/{version}/models?key={KEY}&pageSize=200"
    try:
        with urllib.request.urlopen(url) as r:
            data = json.load(r)
        live = [
            m["name"]
            for m in data.get("models", [])
            if "bidiGenerateContent" in m.get("supportedGenerationMethods", [])
        ]
        print(f"\n{version}: {live if live else '(none)'}")
    except Exception as e:
        print(f"\n{version}: ERROR {e}")
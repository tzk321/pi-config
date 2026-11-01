"""Best-effort Bing RSS fallback; standard library only."""
import json
import sys
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET


def main():
    if len(sys.argv) != 2 or not sys.argv[1].strip():
        raise SystemExit("Usage: search.py 'query'")
    url = "https://www.bing.com/search?" + urllib.parse.urlencode(
        {"format": "rss", "q": sys.argv[1]}
    )
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=25) as response:
        data = response.read(2_000_001)
    if len(data) > 2_000_000:
        raise ValueError("Bing response too large")
    root = ET.fromstring(data)
    results = [
        {"title": item.findtext("title"), "url": item.findtext("link"),
         "snippet": item.findtext("description")}
        for item in root.findall(".//item")[:10]
    ]
    if not results:
        raise ValueError("Bing RSS returned no results")
    print(json.dumps({"provider": "bing-rss", "results": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Bing fallback failed: {exc}", file=sys.stderr)
        sys.exit(1)

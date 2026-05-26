import re
import time
import urllib.request
from collections import Counter
from urllib.parse import urljoin, urlparse


def fetch_page(url: str, timeout: int = 10) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read().decode("utf-8", errors="replace")


def extract_links(html: str, base_url: str) -> list[str]:
    pattern = re.compile(r'href=["\']([^"\'#?]+)["\']', re.IGNORECASE)
    raw = pattern.findall(html)
    links = []
    for href in raw:
        full = urljoin(base_url, href)
        parsed = urlparse(full)
        if parsed.scheme in ("http", "https"):
            links.append(full)
    return list(set(links))


def extract_words(html: str) -> list[str]:
    text = re.sub(r"<[^>]+>", " ", html)
    words = re.findall(r"\b[a-zA-Z]{3,}\b", text)
    return [w.lower() for w in words]


def crawl(
    start_url: str,
    max_pages: int = 10,
    delay: float = 0.5,
    same_domain: bool = True,
) -> dict:
    visited: set[str] = set()
    queue: list[str] = [start_url]
    word_counts: Counter = Counter()
    link_graph: dict[str, list[str]] = {}
    errors: list[str] = []

    base_domain = urlparse(start_url).netloc

    while queue and len(visited) < max_pages:
        url = queue.pop(0)
        if url in visited:
            continue

        try:
            html = fetch_page(url)
            links = extract_links(html, url)
            words = extract_words(html)

            visited.add(url)
            word_counts.update(words)
            link_graph[url] = links

            for link in links:
                if same_domain and urlparse(link).netloc != base_domain:
                    continue
                if link not in visited:
                    queue.append(link)

            time.sleep(delay)

        except Exception as e:
            errors.append(f"{url}: {e}")

    return {
        "pages_visited": len(visited),
        "top_words": word_counts.most_common(20),
        "link_graph": link_graph,
        "errors": errors,
    }


if __name__ == "__main__":
    import sys
    import json

    url = sys.argv[1] if len(sys.argv) > 1 else "https://example.com"
    result = crawl(url, max_pages=5)
    print(json.dumps(result, indent=2))

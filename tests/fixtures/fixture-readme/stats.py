from collections import Counter
from typing import Any


def top_n(counter: Counter, n: int = 10) -> list[tuple[str, int]]:
    return counter.most_common(n)


def domain_distribution(link_graph: dict[str, list[str]]) -> dict[str, int]:
    from urllib.parse import urlparse

    counts: dict[str, int] = {}
    for links in link_graph.values():
        for link in links:
            domain = urlparse(link).netloc
            counts[domain] = counts.get(domain, 0) + 1
    return dict(sorted(counts.items(), key=lambda x: x[1], reverse=True))


def summary(result: dict[str, Any]) -> str:
    lines = [
        f"Pages visited : {result['pages_visited']}",
        f"Errors        : {len(result['errors'])}",
        f"Unique domains: {len(domain_distribution(result['link_graph']))}",
        "",
        "Top 10 words:",
    ]
    for word, count in result["top_words"][:10]:
        lines.append(f"  {word:<20} {count}")
    return "\n".join(lines)

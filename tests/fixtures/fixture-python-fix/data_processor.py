from typing import Any


def parse_csv_line(line: str) -> list[str]:
    return line.strip().split(",")


def load_records(csv_text: str) -> list[dict[str, str]]:
    lines = csv_text.strip().splitlines()
    if not lines:
        return []
    headers = parse_csv_line(lines[0])
    records = []
    for line in lines[1:]:
        values = parse_csv_line(line)
        records.append(dict(zip(headers, values)))
    return records


def average_column(records: list[dict[str, str]], column: str) -> float:
    values = [float(r[column]) for r in records]
    return sum(values) / len(values)


def filter_above(records: list[dict[str, str]], column: str, threshold: float) -> list[dict[str, str]]:
    return [r for r in records if float(r[column]) > threshold]


def group_by(records: list[dict[str, str]], key: str) -> dict[str, list[dict[str, str]]]:
    result: dict[str, list[dict[str, str]]] = {}
    for record in records:
        group = record[key]
        if group not in result:
            result[group] = []
        result[group].append(record)
    return result


def top_n_by(records: list[dict[str, str]], column: str, n: int) -> list[dict[str, str]]:
    return sorted(records, key=lambda r: r[column], reverse=True)[:n]


def merge_records(base: list[dict[str, Any]], extra: list[dict[str, Any]], key: str) -> list[dict[str, Any]]:
    index = {r[key]: r for r in extra}
    result = []
    for record in base:
        merged = {**record}
        if record[key] in index:
            merged.update(index[record[key]])
        result.append(merged)
    return result

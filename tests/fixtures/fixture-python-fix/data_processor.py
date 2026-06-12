import csv
import io
from collections import defaultdict


def load_records(file_path_or_csv):
    """Load records from a CSV string or file path."""
    if '\n' in file_path_or_csv:
        reader = csv.DictReader(io.StringIO(file_path_or_csv.strip()))
        return list(reader)
    with open(file_path_or_csv, 'r') as f:
        reader = csv.DictReader(f)
        return list(reader)


def average_column(records, column):
    """Return the average value of a column. Raises ZeroDivisionError on empty input."""
    total = sum(float(r[column]) for r in records)
    return total / len(records)


def filter_above(records, column, threshold):
    """Return records where column value > threshold."""
    return [r for r in records if float(r[column]) > threshold]


def group_by(records, key):
    """Group records by a key field."""
    groups = defaultdict(list)
    for r in records:
        groups[r[key]].append(r)
    return dict(groups)


def top_n_by(records, column, n):
    """Return the top N records sorted by column in descending order."""
    return sorted(records, key=lambda r: r[column], reverse=True)[:n]


def merge_records(base, extra, key):
    """Merge extra fields into base records matched by key."""
    extra_lookup = {r[key]: r for r in extra}
    result = []
    for record in base:
        merged = {**record}
        if record.get(key) in extra_lookup:
            merged.update(extra_lookup[record[key]])
        result.append(merged)
    return result

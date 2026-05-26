import pytest
from data_processor import (
    load_records,
    average_column,
    filter_above,
    group_by,
    top_n_by,
    merge_records,
)

CSV = """name,score,department
Alice,92,Engineering
Bob,78,Marketing
Carol,88,Engineering
Dave,65,Marketing
Eve,95,Engineering
"""


def test_load_records():
    records = load_records(CSV)
    assert len(records) == 5
    assert records[0]["name"] == "Alice"


def test_average_column():
    records = load_records(CSV)
    avg = average_column(records, "score")
    assert abs(avg - 83.6) < 0.01


def test_average_empty_should_raise():
    with pytest.raises(ZeroDivisionError):
        average_column([], "score")


def test_filter_above():
    records = load_records(CSV)
    high = filter_above(records, "score", 85)
    names = [r["name"] for r in high]
    assert "Alice" in names
    assert "Carol" in names
    assert "Eve" in names
    assert "Bob" not in names


def test_group_by():
    records = load_records(CSV)
    groups = group_by(records, "department")
    assert len(groups["Engineering"]) == 3
    assert len(groups["Marketing"]) == 2


def test_top_n_by_numeric():
    records = load_records(CSV)
    top = top_n_by(records, "score", 2)
    names = [r["name"] for r in top]
    assert names[0] == "Eve"
    assert names[1] == "Alice"


def test_merge_records():
    base = [{"id": "1", "name": "Alice"}, {"id": "2", "name": "Bob"}]
    extra = [{"id": "1", "dept": "Engineering"}]
    merged = merge_records(base, extra, "id")
    alice = next(r for r in merged if r["id"] == "1")
    assert alice["dept"] == "Engineering"
    bob = next(r for r in merged if r["id"] == "2")
    assert "dept" not in bob

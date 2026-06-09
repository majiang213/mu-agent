def filter_above(data, threshold):
    return [x for x in data if x > threshold]
def load_records(file_path):
    # Placeholder implementation assuming file loading logic goes here
    print(f"Loading records from {file_path}")
    return [1, 2, 3] # Dummy data for testing purposes
def average_column(records, column):
    if not records:
        return 0
    total = sum(record.get(column, 0) for record in records)
    return total / len(records)

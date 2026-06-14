import os


def test_readme_created():
    assert os.path.exists('README.md'), "README.md must be created"


def test_readme_has_content():
    with open('README.md') as f:
        content = f.read()
    assert len(content) > 200, f"README.md too short ({len(content)} chars)"
    assert 'crawl' in content.lower(), "README.md should document crawling functionality"

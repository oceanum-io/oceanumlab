import json
import os


async def test_get_returns_the_environment_variable(jp_fetch, monkeypatch):
    monkeypatch.setenv("OCEANUMLAB_TEST_VAR", "hello")

    response = await jp_fetch("oceanum", "env", "OCEANUMLAB_TEST_VAR")

    assert response.code == 200
    assert json.loads(response.body) == {"OCEANUMLAB_TEST_VAR": "hello"}


async def test_get_returns_null_for_an_unset_variable(jp_fetch, monkeypatch):
    monkeypatch.delenv("OCEANUMLAB_TEST_UNSET", raising=False)

    response = await jp_fetch("oceanum", "env", "OCEANUMLAB_TEST_UNSET")

    assert response.code == 200
    assert json.loads(response.body) == {"OCEANUMLAB_TEST_UNSET": None}


async def test_post_sets_the_environment_variables(jp_fetch, monkeypatch):
    # The frontend posts the Datamesh token here, so code run in the server's
    # kernels can read it. Set first so monkeypatch restores it afterwards.
    monkeypatch.setenv("OCEANUMLAB_TEST_TOKEN", "old")

    response = await jp_fetch(
        "oceanum",
        "env/",
        method="POST",
        body=json.dumps({"OCEANUMLAB_TEST_TOKEN": "a-token"}),
    )

    assert response.code == 200
    assert os.environ["OCEANUMLAB_TEST_TOKEN"] == "a-token"

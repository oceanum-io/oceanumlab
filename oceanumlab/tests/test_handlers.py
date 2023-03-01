import os
import json


async def test_get_example(jp_fetch):
    os.environ["TEST"] = "test"
    # When
    response = await jp_fetch("oceanum", "env", "TEST")

    # Then
    assert response.code == 200
    payload = json.loads(response.body)
    assert payload == {"TEST": "test"}

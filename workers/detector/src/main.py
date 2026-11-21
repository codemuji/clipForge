"""Detector server entry point on 127.0.0.1:8731."""

import os
import uvicorn
from .app import app


def run():
    host = os.environ.get("DETECTOR_HOST", "127.0.0.1")
    port = int(os.environ.get("DETECTOR_PORT", "8731"))
    uvicorn.run(app, host=host, port=port)


if __name__ == "__main__":
    run()

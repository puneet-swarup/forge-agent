"""A small module."""

import os, sys
from pathlib import Path

# The runner.
class Runner:
    def __init__(self, name):
        self.name = name

    def run(self):
        return self.name

    async def stop(self):
        pass

def main():
    print("hi")

def tail():
    return 2

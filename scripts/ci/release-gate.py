#!/usr/bin/env python3
"""Publish changed versions on main pushes, or an explicitly requested main dispatch."""
import json
import os
import subprocess
from package import version


def should_publish(event_name, ref, event):
    if ref != 'refs/heads/main':
        return False
    if event_name == 'workflow_dispatch':
        return str(event.get('inputs', {}).get('publish', False)).lower() == 'true'
    if event_name != 'push':
        return False
    before = event.get('before', '')
    if not before or set(before) == {'0'}:
        return False
    try:
        previous = subprocess.check_output(['git', 'show', f'{before}:package.json'], text=True, stderr=subprocess.DEVNULL)
        old = json.loads(previous)['version']
    except subprocess.CalledProcessError:
        # The pre-rewrite main stores its version in CMake instead of package.json.
        import re
        previous = subprocess.check_output(['git', 'show', f'{before}:CMakeLists.txt'], text=True)
        old = re.search(r'project\(EncosMotorCLI VERSION ([0-9.]+)\)', previous)[1]
    return old != version()


if __name__ == '__main__':
    result = should_publish(os.environ['GITHUB_EVENT_NAME'], os.environ['GITHUB_REF'], json.loads(os.environ.get('GITHUB_EVENT_JSON', '{}')))
    output = f'should_run={str(result).lower()}\n'
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a') as stream:
            stream.write(output)
    print(output, end='')

"""Check credential prompt privacy in an isolated PTY with disposable fake values."""
import json
import os
import pty
import select
import shutil
import stat
import subprocess
import tempfile
import time
from pathlib import Path

source = Path(__file__).with_name('setup-mail.mjs')
with tempfile.TemporaryDirectory(prefix='shortlist-mail-setup-') as directory:
    root = Path(directory)
    (root / '.helper').mkdir()
    script = root / '.helper/setup-mail.mjs'
    shutil.copyfile(source, script)
    master, slave = pty.openpty()
    process = subprocess.Popen(['node', str(script), '--local'], stdin=slave, stdout=slave, stderr=slave, close_fds=True)
    os.close(slave)
    output = b''
    sent_user = sent_password = False
    password = 'DISPOSABLE-test-password-5831'
    deadline = time.monotonic() + 10
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([master], [], [], 0.1)
            if ready:
                try:
                    block = os.read(master, 65536)
                except OSError:
                    break
                if not block:
                    break
                output += block
                if b'IITK mail username' in output and not sent_user:
                    os.write(master, b'synthetic-test-user\n')
                    sent_user = True
                if b'password (hidden):' in output and not sent_password:
                    os.write(master, password.encode() + b'\n')
                    sent_password = True
            elif process.poll() is not None:
                break
        process.wait(timeout=2)
        assert process.returncode == 0, 'Isolated setup helper failed'
        assert password.encode() not in output, 'Password was echoed to the terminal'
        env_file = root / '.dev.vars'
        assert stat.S_IMODE(env_file.stat().st_mode) == 0o600
        assert json.dumps(password) in env_file.read_text()
        print(json.dumps({'password_hidden': True, 'local_secret_permissions': '0600', 'all_credentials_disposable': True}))
    finally:
        if process.poll() is None:
            process.kill()
        os.close(master)

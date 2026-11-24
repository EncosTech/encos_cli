import platform
import os, pty, subprocess, select, time, tempfile, shutil, re, fcntl, termios, struct, sys
from pathlib import Path
with tempfile.TemporaryDirectory(prefix='emcli-sea-tui-') as tmp:
    source=Path(sys.argv[1] if len(sys.argv) > 1 else 'dist/emcli-linux-' + {'x86_64':'x64','aarch64':'arm64'}[platform.machine()]).resolve()
    binary=source if '--installed' in sys.argv else Path(tmp)/'emcli'
    if binary!=source:shutil.copy2(source,binary)
    master,slave=pty.openpty();fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,150,0,0))
    env={**os.environ,'PATH':'','NODE_PATH':'','NODE_OPTIONS':'','EMCLI_SEA_CACHE':tmp+'/cache','CI':'true','TERM':'xterm-256color','FORCE_COLOR':'1'}
    for key in ('EMCLI_PERF_ADDON','EMCLI_NATIVE_ROOT','EMCLI_JSON_WORKER','EMCLI_STUDIO_OPTIONS','LD_LIBRARY_PATH'):env.pop(key,None)
    def own_terminal():
        os.setsid()
        fcntl.ioctl(slave,termios.TIOCSCTTY,0)
    process=subprocess.Popen([str(binary),'tui','--demo'],cwd=tmp,env=env,stdin=slave,stdout=slave,stderr=slave,preexec_fn=own_terminal)
    output=b'';late_mouse_sent=False
    late_mouse=b'\x1b[<35;137;29M'
    def collect(seconds):
        global output, late_mouse_sent
        until=time.monotonic()+seconds
        while time.monotonic()<until:
            if select.select([master],[],[],0.05)[0]:
                try: chunk=os.read(master,65536)
                except OSError: break
                if not chunk:break
                output+=chunk
                if not late_mouse_sent and b'\x1b[?1003l' in output:
                    # Simulate a mouse report already in flight while shutdown
                    # disables terminal tracking (not a new click in the shell).
                    assert not (termios.tcgetattr(slave)[3] & termios.ECHO), 'Input echo restored before mouse shutdown completed'
                    os.write(master,late_mouse)
                    late_mouse_sent=True
    try:
        deadline=time.monotonic()+20
        while time.monotonic()<deadline:
            collect(.1)
            text=re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]','',output.decode(errors='replace'))
            assert process.poll() is None,text[-4000:]
            if 'Devices' in text and 'Motor 1' in text:break
        else:raise AssertionError('TUI did not become ready within 20 seconds: '+text[-4000:])
        def tty_nr(pid):
            return int(Path('/proc/'+str(pid)+'/stat').read_text().split(') ')[1].split()[4])
        assert tty_nr(process.pid)!=0,'Test must own a controlling terminal'
        children=Path('/proc/'+str(process.pid)+'/task/'+str(process.pid)+'/children').read_text().split()
        assert children,'No driver worker found'
        for pid in children:assert tty_nr(pid)==0,'Driver worker inherited the TUI terminal'
        os.write(master,b'\x03');collect(.5);os.write(master,b'\x03');collect(3)
        assert process.wait(timeout=5)==0,text[-4000:]
        assert b'\x1b[?1049l' in output,'Alternate screen was not restored'
        assert late_mouse_sent, 'Mouse tracking was not disabled'
        assert b'[<35;137;29M' not in output, 'Mouse report echoed during shutdown'
        assert termios.tcgetattr(slave)[3] & termios.ECHO, 'Terminal input echo was not restored'
        assert termios.tcgetattr(slave)[3] & termios.ICANON, 'Terminal canonical input was not restored'
        print('PASS packaged TUI: Fake demo motors, driver IPC worker, double Ctrl+C exit, alternate screen and input echo restored, late mouse report drained; empty PATH and isolated directory/cache')
    finally:
        if process.poll() is None:process.kill();process.wait()
        os.close(slave)
        os.close(master)

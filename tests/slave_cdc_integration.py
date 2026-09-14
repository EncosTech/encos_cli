#!/usr/bin/env python3
"""Exercise real serialib against a PTY, including stop-on-save-failure."""
import os, pty, select, subprocess, sys, time
binary=sys.argv[1]
def run(item, value, replies, expected, success):
    master, slave=pty.openpty()
    device=os.ttyname(slave)
    process=subprocess.Popen([binary,'config','Ethercat:'+device,item,'set',value],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    seen=[];pending=b'';end=time.monotonic()+5
    while process.poll() is None and time.monotonic()<end:
        if not select.select([master],[],[],.05)[0]:continue
        pending+=os.read(master,1024)
        while b'\n' in pending:
            line,pending=pending.split(b'\n',1)
            seen.append(line.decode().strip())
            if len(seen)<=len(replies):os.write(master,(replies[len(seen)-1]+'\r\n').encode())
    try: out,err=process.communicate(timeout=1)
    finally:
        if process.poll() is None:process.kill()
        os.close(master);os.close(slave)
    assert seen==expected,(seen,out,err)
    assert (process.returncode==0)==success,(out,err)
run('mode','ecat',['OK STAGED','OK SAVED','OK REBOOT'],['MODE SET ECAT','CONFIG SAVE','REBOOT'],True)
run('ip','192.168.100.11',['OK STAGED','ERR BUSY'],['NET SETIP 192.168.100.11','CONFIG SAVE'],False)
for mode in ('usb3can','usb8can'):
    run('mode',mode,['OK STAGED','OK SAVED','OK REBOOT'],['MODE SET '+mode.upper(),'CONFIG SAVE','REBOOT'],True)
print('CDC workflow: save then reboot; save failure prevents reboot')

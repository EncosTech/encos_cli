#!/usr/bin/env python3
# SPDX-License-Identifier: MIT

"""Run emcli against a loopback EMM1 peer; validate retries and stop-on-error."""
import socket,struct,subprocess,sys,time
binary=sys.argv[1]
uuid='1234567890abcdef1234567890abcdef'
def run(fail_save=False):
    with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as sock:
        sock.bind(('0.0.0.0',5001));sock.settimeout(.1)
        process=subprocess.Popen([binary,'config','Ethernet:lo:'+uuid,'mode','set','ecat'],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
        seen=[];requests={};end=time.monotonic()+6
        while process.poll() is None and time.monotonic()<end:
            try:data,peer=sock.recvfrom(2048)
            except socket.timeout:continue
            assert len(data)==64 and data[:8]==b'EMM1'+bytes([1,12,64,0])
            assert data[12:28].hex()==uuid
            request=data[8:12];command=data[28:].split(b'\0',1)[0].decode()
            if request not in requests:
                seen.append(command);requests[request]=data
                if len(seen)==1:continue # Drop first ACK to exercise retransmission.
            else:assert requests[request]==data
            text='ERR BUSY' if fail_save and command=='CONFIG SAVE' else 'OK '+command
            response=bytearray(256);response[:28]=data[:28];response[5]=13;response[6:8]=b'\0\1';response[28:28+len(text)]=text.encode()
            # Bad request ID must be ignored.
            bad=response.copy();bad[8]^=0x80;sock.sendto(bad,peer)
            sock.sendto(response,peer)
        try:out,err=process.communicate(timeout=1)
        finally:
            if process.poll() is None:process.kill()
        assert seen==(['MODE SET ECAT','CONFIG SAVE'] if fail_save else ['MODE SET ECAT','CONFIG SAVE','REBOOT']),seen
        assert (process.returncode==0)==(not fail_save),(out,err)
run();run(True)
print('UDP workflow: UUID targeting, identical retries, response matching, save failure stops reboot')

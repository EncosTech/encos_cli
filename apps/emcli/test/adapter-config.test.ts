// SPDX-License-Identifier: MIT

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AdapterConfigurator,
  validateConfigPort,
  linuxCdcPorts,
  parseWindowsCdcPorts,
  networkFromIp,
  networkFromSlave,
} from '../src/studio/adapter-config.js'
import { listFiles } from '../src/studio/files.js'

test('CDC enumeration uses USB interface descriptors and device names, not tty spelling', async () => {
  const root = await mkdtemp(join(tmpdir(), 'emcli-cdc-'))

  try {
    await mkdir(join(root, 'class/tty'), { recursive: true })

    for (const [name, usbClass, subclass] of [
      ['ttyACM0', '02', '02'],
      ['ttyACM1', 'ff', '00'],
      ['ttyUSB0', '02', '02'],
    ]) {
      const device = join(root, 'devices', name!),
        iface = join(device, 'interface')

      await mkdir(iface, { recursive: true })
      await mkdir(join(root, 'class/tty', name!), { recursive: true })
      await writeFile(join(device, 'product'), 'Encos Gateway\n')
      await writeFile(join(iface, 'bInterfaceClass'), usbClass!)
      await writeFile(join(iface, 'bInterfaceSubClass'), subclass!)
      await symlink(iface, join(root, 'class/tty', name!, 'device'))
    }

    assert.deepEqual(await linuxCdcPorts(join(root, 'class/tty')), [
      { port: '/dev/ttyACM0', name: 'Encos Gateway' },
      { port: '/dev/ttyUSB0', name: 'Encos Gateway' },
    ])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('Windows filters usbser service rather than accepting every COM port', () => {
  assert.deepEqual(
    parseWindowsCdcPorts(
      JSON.stringify([
        { Name: 'Encos Gateway (COM12)', Service: 'usbser' },
        { Name: 'FTDI (COM3)', Service: 'FTSER2K' },
      ]),
    ),
    [{ port: 'COM12', name: 'Encos Gateway' }],
  )
})

test('network editors share validated IP/slave mapping', () => {
  assert.deepEqual(networkFromSlave('0'), { slaveId: 0, ip: '192.168.100.1' })
  assert.deepEqual(networkFromIp('192.168.100.253'), { slaveId: 252, ip: '192.168.100.253' })

  for (const value of ['', '-1', '253', '1.5']) assert.equal(networkFromSlave(value), undefined)

  for (const value of ['192.168.100.', '192.168.100.254', '10.0.0.1'])
    assert.equal(networkFromIp(value), undefined)
})

test('opening reads mode and Enet network; writes reuse save/reboot and close session', () => {
  const calls: string[][] = []

  const native = () => ({
    slave: (args: string[]) => {
      calls.push(args)

      return {
        handled: true,
        code: 0,
        replies:
          args[2] === 'mode'
            ? ['OK ACTIVE=UDP NEXT=UDP SAVED=1']
            : ['OK IP=192.168.100.7 SLAVE_ID=6'],
      }
    },
  })

  const config = new AdapterConfigurator(native as any)

  assert.deepEqual(config.open('/dev/ttyACM0'), {
    port: '/dev/ttyACM0',
    mode: 'enet',
    network: { ip: '192.168.100.7', slaveId: 6 },
  })

  config.command('ip', '192.168.100.8')
  assert.equal(config.state, undefined)
  assert.deepEqual(calls.at(-1), ['config', 'Ethernet:/dev/ttyACM0', 'ip', 'set', '192.168.100.8'])
})

test('non Enet opens without NET request and malformed mode leaves session closed', () => {
  const config = new AdapterConfigurator((() => ({
    slave: () => ({ handled: true, code: 0, replies: ['OK ACTIVE=ECAT NEXT=ECAT SAVED=1'] }),
  })) as any)

  assert.equal(config.open('/dev/ttyACM0').mode, 'ecat')
  assert.equal(config.state?.network, undefined)

  const broken = new AdapterConfigurator((() => ({
    slave: () => ({ handled: true, code: 0, replies: ['OK'] }),
  })) as any)

  assert.throws(() => broken.open('/dev/ttyACM0'), /mode/)
  assert.equal(broken.state, undefined)
})

test('firmware file listing keeps directories and upd/bin/elf, CSV default is preserved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'emcli-files-'))

  try {
    for (const name of ['a.csv', 'b.bin', 'c.ELF', 'd.txt', 'e.upd'])
      await writeFile(join(root, name), '')

    await mkdir(join(root, 'folder'))

    assert.deepEqual(
      (await listFiles(root)).entries.map((e) => e.name),
      ['folder', 'a.csv'],
    )

    assert.deepEqual(
      (await listFiles(root, ['.upd', '.bin', '.elf'])).entries.map((e) => e.name),
      ['folder', 'b.bin', 'c.ELF', 'e.upd'],
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('manual serial ports are accepted only when discovery returns no devices', () => {
  assert.doesNotThrow(() => validateConfigPort('/dev/ttyACM9', []))
  assert.doesNotThrow(() => validateConfigPort('COM9', []))

  const ports = [{ port: '/dev/ttyACM0', name: 'Encos Gateway' }]

  assert.doesNotThrow(() => validateConfigPort('/dev/ttyACM0', ports))
  assert.throws(() => validateConfigPort('/dev/ttyACM9', ports), /available USB CDC/)
  assert.throws(() => validateConfigPort('invalid', []), /valid serial port/)
  assert.throws(() => validateConfigPort('/dev/ttyACM0\n', []), /valid serial port/)
})

test('firmware download accepts an existing UPD package without repackaging', () => {
  const calls: string[][] = []
  const config = new AdapterConfigurator((() => ({
    slave: (args: string[]) => {
      calls.push(args)

      return { handled: true, code: 0, replies: ['OK ACTIVE=ECAT NEXT=ECAT SAVED=1'] }
    },
  })) as any)

  config.open('/dev/ttyACM0')
  config.command('download', '/tmp/firmware.upd')

  assert.deepEqual(calls.at(-1), [
    'config',
    'Ethernet:/dev/ttyACM0',
    'download',
    '/tmp/firmware.upd',
  ])
})

function restartingPort() {
  let probes = 0

  return async () => (++probes === 1 ? 'original' : 'returned')
}

test('Apply reconnects after reboot and reloads current mode and network', async () => {
  let rebooted = false
  let attempts = 0
  const config = new AdapterConfigurator(
    (() => ({
      slave: (args: string[]) => {
        if (args.includes('set')) {
          rebooted = true

          return { handled: true, code: 0, replies: ['OK REBOOT'] }
        }

        if (rebooted && ++attempts === 1) throw new Error('CDC disconnected')

        return {
          handled: true,
          code: 0,
          replies: [
            args[2] === 'ip'
              ? 'OK IP=192.168.100.8'
              : rebooted
                ? 'OK ACTIVE=UDP'
                : 'OK ACTIVE=ECAT',
          ],
        }
      },
    })) as any,
    undefined,
    restartingPort(),
  )

  config.open('/dev/ttyACM0')
  const result = await config.commandAndReconnect('mode', 'enet')

  assert.deepEqual(result, {
    port: '/dev/ttyACM0',
    mode: 'enet',
    network: { slaveId: 7, ip: '192.168.100.8' },
  })
})

test('reconnection timeout and failed Apply leave configuration closed', async () => {
  let failing = false
  const config = new AdapterConfigurator(
    (() => ({
      slave: (args: string[]) => {
        if (args.includes('set')) return { handled: true, code: 0, replies: ['OK REBOOT'] }
        if (failing) throw new Error('CDC disconnected')

        return { handled: true, code: 0, replies: ['OK ACTIVE=ECAT'] }
      },
    })) as any,
    undefined,
    restartingPort(),
  )

  config.open('/dev/ttyACM0')
  failing = true
  await assert.rejects(
    config.commandAndReconnect('mode', 'enet', { reconnectTimeoutMs: 30 }),
    /Reconnect timed out/,
  )
  assert.equal(config.state, undefined)

  failing = false
  config.open('/dev/ttyACM0')
  failing = true
  await assert.rejects(config.commandAndReconnect('reboot'), /CDC disconnected/)
  assert.equal(config.state, undefined)
})

test('closing configuration cancels a pending reconnect without reopening the port', async () => {
  let reads = 0
  const config = new AdapterConfigurator(
    (() => ({
      slave: (args: string[]) => {
        if (args[2] === 'mode') reads++

        return { handled: true, code: 0, replies: ['OK ACTIVE=ECAT'] }
      },
    })) as any,
    undefined,
    restartingPort(),
  )

  config.open('/dev/ttyACM0')
  const reconnect = config.commandAndReconnect('reboot')
  config.close()

  await assert.rejects(reconnect, /cancelled/)
  assert.equal(reads, 1)
  assert.equal(config.state, undefined)
})

test('reconnect waits for CDC return before sending commands and starting its own timeout', async () => {
  let rebootAt = 0
  let sawDisconnect = false
  const config = new AdapterConfigurator(
    (() => ({
      slave: (args: string[]) => {
        if (args[2] === 'reboot') {
          rebootAt = performance.now()

          return { handled: true, code: 0, replies: ['OK REBOOT'] }
        }

        if (rebootAt)
          assert.ok(
            performance.now() - rebootAt >= 1700,
            'must not send CDC commands while the device is restarting',
          )

        return { handled: true, code: 0, replies: ['OK ACTIVE=ECAT'] }
      },
    })) as any,
    undefined,
    async () => {
      if (!rebootAt || performance.now() - rebootAt < 450) return 'original'

      if (performance.now() - rebootAt < 1700) {
        sawDisconnect = true

        return null
      }

      return 'returned'
    },
  )

  config.open('/dev/ttyACM0')
  await config.commandAndReconnect('reboot', undefined, {
    restartTimeoutMs: 2500,
    reconnectTimeoutMs: 1600,
  })

  assert.equal(sawDisconnect, true)
  assert.equal(config.command('mode')?.mode, 'ecat')
})

test('restart timeout returns to port selection without probing firmware', async () => {
  let reads = 0
  const config = new AdapterConfigurator(
    (() => ({
      slave: (args: string[]) => {
        if (args[2] === 'mode') reads++

        return { handled: true, code: 0, replies: ['OK ACTIVE=ECAT'] }
      },
    })) as any,
    undefined,
    async () => 'original',
  )

  config.open('/dev/ttyACM0')
  await assert.rejects(
    config.commandAndReconnect('reboot', undefined, {
      restartTimeoutMs: 30,
    }),
    /Adapter restart timed out/,
  )

  assert.equal(reads, 1)
  assert.equal(config.state, undefined)
})

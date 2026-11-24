import test from 'node:test'
import assert from 'node:assert/strict'
import {createChartStore,type ChartPoint} from '../src/tui/chart-store.js'
import {IMU_SERIES,appendImuSample} from '../src/studio/imu-chart.js'
import type {DeviceSample} from '../src/studio/protocol.js'
test('IMU histories retain all three groups, skip other devices and mark missing components as gaps',()=>{
 const store=createChartStore({series:IMU_SERIES,flushIntervalMs:0})
 const sample:DeviceSample={kind:'imu',deviceKey:'imu1',timestamp:Date.now(),status:{acceleration:{x:1,y:2,z:3},angularVelocity:{x:4,y:5,z:6},eulerAngle:{pitch:7,roll:8,heading:9}}}
 appendImuSample(store,sample,'imu2');assert.ok(store.getSnapshot().every(s=>!s.data.length))
 appendImuSample(store,sample,'imu1');assert.equal(store.getSnapshot().length,9)
 assert.deepEqual(store.getSnapshot().map(s=>(s.data[0] as ChartPoint).value),[1,2,3,4,5,6,7,8,9])
 appendImuSample(store,{...sample,timestamp:sample.timestamp+1,status:{}},'imu1')
 assert.ok(store.getSnapshot().every(s=>Number.isNaN((s.data[1] as ChartPoint).value)))
 store.dispose()
})

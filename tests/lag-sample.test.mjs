import test from 'node:test';
import assert from 'node:assert/strict';
import { startLagSample } from '../client/lag-sample.js';

test('foreground sample includes a task spanning the event, separates later work and removes every listener', () => {
    const events = new Map(), document = new EventTarget();
    const pending = [];
    let now = 1000, stopped = 0, timer, result;
    const host = {document, performance:{now:()=>now}, setTimeout(cb){timer=cb;return 1;},clearTimeout(){timer=null;},
        PerformanceObserver: class {
            static supportedEntryTypes=['longtask'];
            observe(){} takeRecords(){return pending.splice(0);} disconnect(){stopped++;}
        }};
    const finish=startLagSample({host,events:{on:(name,fn)=>events.set(name,fn),removeListener:name=>events.delete(name)},onFinish:r=>{result=r;}});
    events.get('js_generation_requested')('private-id','generateRaw',{ignored:'private'});
    now=4200; events.get('js_generation_ended')('private response','private-id');
    pending.push({startTime:995,duration:680},{startTime:4800,duration:108},{startTime:10000,duration:820});
    now=13000; document.hidden=true; document.dispatchEvent(new Event('visibilitychange')); finish();
    assert.deepEqual(result,{seconds:12,tasks:3,peakMs:820,request:{events:1,peakMs:680},end:{events:1,peakMs:108},truncated:false});
    assert.equal(timer,null);assert.equal(stopped,1);assert.equal(events.size,0);
});

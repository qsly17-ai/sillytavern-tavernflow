// Record timing only while the user is investigating a foreground pause.
// Browser long tasks identify a busy main thread, not the responsible extension.
export function startLagSample({ host = globalThis, events, onFinish }) {
    const Observer = host.PerformanceObserver;
    if (!Observer?.supportedEntryTypes?.includes('longtask') || host.document.hidden) return;
    const started = host.performance.now();
    const marks = [], tasks = [];
    const maxRows = 256;
    let dropped = false, finished = false, timer;
    const add = (list, value) => {
        if (list.length < maxRows) list.push(value);
        else dropped = true;
    };
    const collect = entries => {
        for (const entry of entries) add(tasks, { start: entry.startTime, end: entry.startTime + entry.duration });
    };
    const observer = new Observer(list => collect(list.getEntries()));
    const listeners = [];
    const finish = () => {
        if (finished) return;
        finished = true;
        collect(observer.takeRecords());
        observer.disconnect();
        host.clearTimeout(timer);
        host.document.removeEventListener('visibilitychange', visibility);
        for (const [name, handler] of listeners) events.removeListener(name, handler);
        const peak = (rows) => Math.round(rows.reduce((max, task) => Math.max(max, task.end - task.start), 0));
        const around = kind => {
            const times = marks.filter(mark => mark.kind === kind);
            // Check interval overlap: a callback may fire halfway through a long task.
            const nearby = tasks.filter(task => times.some(mark => task.end >= mark.at && task.start <= mark.at + 2500));
            return { events: times.length, peakMs: peak(nearby) };
        };
        onFinish({ seconds: Math.ceil((host.performance.now() - started) / 1000), tasks: tasks.length, peakMs: peak(tasks),
            request: around('request'), end: around('end'), truncated: dropped });
    };
    const visibility = () => { if (host.document.hidden) finish(); };
    try {
        observer.observe({ type: 'longtask' });
        if (events?.on && events.removeListener) {
            for (const [name, kind] of [['js_generation_requested', 'request'], ['js_generation_ended', 'end']]) {
                const handler = () => add(marks, { kind, at: host.performance.now() });
                events.on(name, handler);
                listeners.push([name, handler]);
            }
        }
        host.document.addEventListener('visibilitychange', visibility);
        timer = host.setTimeout(finish, 120000);
        return finish;
    } catch {
        finish();
    }
}

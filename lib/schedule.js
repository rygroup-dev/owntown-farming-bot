function parseSchedule(raw) {
  return String(raw || '')
    .split(',')
    .map((chunk) => {
      const [stateRaw, hoursRaw] = chunk.split(':');
      const hoursText = String(hoursRaw || '').trim();
      const parsedHours = hoursText ? parseFloat(hoursText) : 1;
      return {
        state: (stateRaw || '').trim().toLowerCase() === 'off' ? 'off' : 'on',
        hours: Number.isFinite(parsedHours) ? parsedHours : 1,
      };
    })
    .filter((phase) => phase.hours > 0);
}

module.exports = { parseSchedule };

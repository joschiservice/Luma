const $ = (selector) => document.querySelector(selector);
let runs = [];
let selected = '';
let connected = false;
let pending = 0;
let queue = Promise.resolve();
const current = () => runs.find((run) => run.id === selected);

async function api(path, body) {
  const response = await fetch(`/api/${path}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      authorization: `Bearer ${$('#token').value}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? 'Request failed');

  return result;
}

function element(tag, text) {
  const node = document.createElement(tag);
  node.textContent = text;

  return node;
}

function render() {
  const run = current();
  $('#runs').replaceChildren(
    ...runs.map((run) => {
      const option = element('option', run.id);
      option.value = run.id;

      return option;
    }),
  );
  $('#runs').value = selected;
  if (!run) return;
  $('#clock').textContent = new Date(run.clock.now).toISOString();
  $('#status').textContent =
    `${run.clock.running ? 'Running' : 'Paused'} · ${run.clock.speed}× · ${run.clock.events.length} scheduled events · seed ${run.seed}`;
  $('#speed').value = String(run.clock.speed);
  const provider = $('#provider').value;
  $('#instance').textContent = `SIMULATED / ${run.id} / ${provider}`;
  $('#state').textContent = JSON.stringify(run[provider], null, 2);
  $('#faults').replaceChildren(
    ...run.clock.faults.map((fault) => {
      const row = element('div', '');
      row.className = 'fault';
      row.append(
        element(
          'span',
          `${fault.id} · ${fault.instance} · ${fault.kind} · ${fault.status}\n${fault.operation} / ${fault.resource ?? 'all resources'} · ${fault.remaining} remaining`,
        ),
      );
      const button = element('button', 'Disable');
      button.className = 'secondary';
      button.disabled = fault.status !== 'armed';
      button.onclick = () => control({ action: 'disable', id: fault.id });
      row.append(button);

      return row;
    }),
  );
  $('#journal').replaceChildren(
    ...run.clock.journal
      .slice(-100)
      .reverse()
      .map((event) => {
        const row = element('div', '');
        row.className = 'event';
        row.append(
          element('span', `#${event.sequence}`),
          element('span', new Date(event.time).toISOString().slice(11)),
          element(
            'strong',
            `${event.kind}${event.instance ? ` / ${event.instance}` : ''}`,
          ),
          element(
            'code',
            `${event.resource ? `[${event.resource}] ` : ''}${JSON.stringify(event.detail)}`,
          ),
        );

        return row;
      }),
  );
}

async function refresh() {
  runs = await api('runs');
  selected ||= runs[0]?.id ?? '';
  render();
}

function control(body) {
  const runId = selected;

  return perform(async () => {
    if (!runId) throw new Error('Create or select a run first');
    await api(`runs/${runId}/control`, body);
    await refresh();
  });
}

function perform(work) {
  pending += 1;
  queue = queue.then(async () => {
    $('#error').textContent = '';
    try {
      await work();
    } catch (error) {
      $('#error').textContent = error.message;
    } finally {
      pending -= 1;
    }
  });

  return queue;
}

$('#connect').onsubmit = (event) => {
  event.preventDefault();
  void perform(async () => {
    await refresh();
    connected = true;
  });
};
$('#create').onsubmit = (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  void perform(async () => {
    await api('runs', { ...data, seed: Number(data.seed) });
    selected = data.id;
    connected = true;
    await refresh();
  });
};
$('#runs').onchange = (event) => {
  selected = event.target.value;
  render();
};
$('#provider').onchange = render;
$('#speed').onchange = (event) =>
  void control({ action: 'speed', speed: Number(event.target.value) });
for (const button of document.querySelectorAll('[data-action]'))
  button.onclick = () =>
    void control({
      action: button.dataset.action,
      ...(button.dataset.action === 'advance' ? { milliseconds: 30000 } : {}),
    });
$('#command').onsubmit = (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  const command = {
    kind: data.kind,
    ...(data.kind !== 'stock' ? { id: data.id } : {}),
    ...(['stock', 'order'].includes(data.kind)
      ? { quantity: Number(data.quantity) }
      : {}),
    ...(data.kind === 'shipping-method'
      ? { shippingMethodId: data.shippingMethodId }
      : {}),
  };
  void control({ action: 'command', instance: $('#provider').value, command });
};
$('#fault [name=kind]').onchange = (event) => {
  const operation = $('#fault [name=operation]');
  operation.disabled = event.target.value === 'response-loss';
  if (operation.disabled) operation.value = 'orders.shipping-method.write';
};
$('#fault').onsubmit = (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  const loss = data.kind === 'response-loss';
  void control({
    action: 'fault',
    rule: {
      instance: $('#provider').value,
      operation: loss ? 'orders.shipping-method.write' : data.operation,
      kind: data.kind,
      phase: loss ? 'after-commit' : 'before',
      occurrence: Number(data.occurrence),
      remaining: Number(data.remaining),
      lifetimeMs: Number(data.lifetime) * 1000,
      ...(data.resource ? { resource: data.resource } : {}),
    },
  });
};
setInterval(() => {
  if (connected && pending === 0) void perform(refresh);
}, 2000);

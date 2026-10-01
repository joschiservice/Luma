const $ = (selector) => document.querySelector(selector);
let runs = [];
let selected = '';
let selectedRun;
let journalEntries = [];
let connected = false;
let pending = 0;
let queue = Promise.resolve();
const current = () => (selectedRun?.id === selected ? selectedRun : undefined);
const operationStatuses = new Map();
const injectionRequests = new Map();
let scenarioBusy = false;

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
  renderInventory();
  renderPurchasing();
  if (!run) return;
  $('#clock').textContent = new Date(run.clock.now).toISOString();
  $('#status').textContent =
    `${run.clock.running ? 'Running' : 'Paused'} · ${run.clock.speed}× · ${run.clock.events.length} scheduled events · seed ${run.seed}`;
  $('#speed').value = String(run.clock.speed);
  const provider = $('#provider').value;
  $('#service-health').disabled = false;
  $('#service-health').value = run.serviceHealth[provider];
  $('#health-status').textContent =
    `${provider.toUpperCase()} · ${$('#service-health').selectedOptions[0].textContent}`;
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
    ...journalEntries.map((event) => {
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
  if (selected) {
    const id = selected;
    const [detail, history] = await Promise.all([
      api(`runs/${id}`),
      api(`runs/${id}/journal?limit=100`),
    ]);
    if (selected !== id) return;
    selectedRun = detail;
    journalEntries = history.items;
    render();
    try {
      operationStatuses.set(id, await api(`runs/${id}/operations`));
    } catch {
      operationStatuses.set(id, {
        ...operationStatuses.get(id),
        unavailable: true,
      });
    }
  }
  render();
}

function renderInventory() {
  const run = current();
  const status = operationStatuses.get(selected);
  const scenario = run?.operationalScenarios?.at(-1);
  const active = scenario?.status === 'injected';
  const left = run?.jtl.items.find((item) => item.id === '2')?.stockAvailable;
  const right = run?.shopify.nodes[
    'gid://shopify/InventoryLevel/2'
  ]?.quantities.find((quantity) => quantity.name === 'available')?.quantity;
  $('#inventory-stock').textContent = run
    ? `JTL ${left} · Shopify ${right}`
    : '—';
  $('#inventory-condition').textContent = !run
    ? 'Select a run'
    : Number(left) === right
      ? scenario
        ? 'Problem removed'
        : 'Stock agrees'
      : 'Stock differs';
  const incident = status?.incident;
  $('#inventory-case').textContent = incident
    ? incident.state === 'resolved'
      ? 'Case resolved'
      : `Open · ${incident.state.replaceAll('_', ' ')}`
    : 'No case yet';
  const enabled =
    !!run && status?.connected && !scenarioBusy && !status.unavailable;
  $('#inject-inventory').disabled =
    !enabled || active || (!!incident && incident.state !== 'resolved');
  $('#recover-inventory').disabled = !enabled || !active;
  $('#check-inventory').disabled = !enabled;
  const link = $('#inventory-case-link');
  link.hidden = !status?.caseUrl;
  if (status?.caseUrl) link.href = status.caseUrl;
  else link.removeAttribute('href');
  const check = status?.lastCheck;
  $('#inventory-check').textContent = scenarioBusy
    ? 'Checking the scenario…'
    : status?.unavailable
      ? 'Luma is unavailable. Waiting to reconnect.'
      : !status?.connected
        ? 'Use the provisioned run from pnpm simulator to detect and resolve issues in Luma.'
        : !check
          ? 'Ready. Create a mismatch or check the current stock.'
          : check.outcome === 'unavailable'
            ? 'Check could not complete. Restore provider service and try Check now.'
            : check.outcome === 'defer'
              ? 'Luma needs complete, comparable stock evidence. The case remains open if one exists.'
              : `Last checked ${new Date(check.at).toLocaleTimeString()} · ${check.outcome === 'detect' ? 'Mismatch detected' : 'Stock agrees'}`;
}

const purchaseStatuses = {
  0: 'Open',
  5: 'Released',
  20: 'In progress',
  30: 'Partially delivered',
  50: 'Overdue',
  500: 'Completed',
};
const profileLabels = {
  full: 'Confirms and delivers in full',
  partial: 'Confirms 60%, +3 days, two deliveries',
  delayed: 'Confirms +7 days, delivers late',
  short: 'Confirms in full, delivers half',
  silent: 'Never answers',
};

function purchaseCommand(command) {
  return control({ action: 'command', instance: 'jtl', command });
}

let purchasingView = '';

function renderPurchasing() {
  const run = current();
  const jtl = run?.jtl;
  const orders = jtl?.purchaseOrders ?? [];
  // Rebuild controls only when purchasing state changes, so polling keeps focus and open menus.
  const view = JSON.stringify([
    run?.id,
    jtl?.suppliers,
    jtl?.supplierProfiles,
    orders,
  ]);
  if (view === purchasingView) return;
  purchasingView = view;
  $('#purchase-count').textContent = run
    ? `${orders.length} purchase order${orders.length === 1 ? '' : 's'}`
    : 'Select a run';
  $('#supplier-profiles').replaceChildren(
    ...(jtl?.suppliers ?? []).map((supplier) => {
      const label = element('label', supplier.companyName);
      const select = document.createElement('select');
      select.setAttribute('aria-label', `${supplier.companyName} profile`);
      for (const [value, text] of Object.entries(profileLabels)) {
        const option = element('option', text);
        option.value = value;
        select.append(option);
      }
      select.value = jtl.supplierProfiles[supplier.id] ?? 'full';
      select.onchange = () =>
        void purchaseCommand({
          kind: 'supplier-profile',
          supplierId: supplier.id,
          profile: select.value,
        });
      label.append(select);

      return label;
    }),
  );
  if (!orders.length) {
    $('#purchase-orders').replaceChildren(
      element('p', run ? 'No purchase orders yet.' : ''),
    );
    $('#purchase-orders').firstChild.className = 'muted';

    return;
  }
  $('#purchase-orders').replaceChildren(
    ...orders.map((order) => {
      const supplier = jtl.suppliers.find((s) => s.id === order.supplierId);
      const row = element('div', '');
      row.className = 'purchase-order';
      const details = element('div', '');
      details.append(
        element(
          'strong',
          `${order.orderNumber} · ${supplier?.companyName ?? order.supplierId}`,
        ),
        element(
          'p',
          `${purchaseStatuses[order.status] ?? order.status} · ${order.isConfirmed ? 'Confirmed' : 'Not confirmed'} · requested ${order.requestedDeliveryDate.slice(0, 10)}`,
        ),
        ...order.lineItems.map((line) =>
          element(
            'p',
            `${line.itemNumber}: ordered ${line.quantity} · confirmed ${line.confirmedQuantity ?? '—'}${line.confirmedDeliveryDate ? ` for ${line.confirmedDeliveryDate.slice(0, 10)}` : ''} · received ${line.deliveredQuantity}`,
          ),
        ),
      );
      const buttons = element('div', '');
      buttons.className = 'buttons';
      const confirm = element('button', 'Confirm in full');
      confirm.className = 'secondary';
      confirm.disabled = order.status === 500;
      confirm.onclick = () =>
        void purchaseCommand({
          kind: 'purchase-order-confirm',
          orderId: order.purchaseOrderId,
        });
      const receive = element('button', 'Receive open quantity');
      receive.className = 'secondary';
      receive.disabled = order.status === 500;
      receive.onclick = () =>
        void purchaseCommand({
          kind: 'purchase-order-receive',
          orderId: order.purchaseOrderId,
          lines: order.lineItems
            .filter((line) => line.openQuantity > 0)
            .map((line) => ({
              lineItemId: line.lineItemId,
              quantity: line.openQuantity,
            })),
        });
      buttons.append(confirm, receive);
      row.append(details, buttons);

      return row;
    }),
  );
}

function scenarioAction(action) {
  const runId = selected;
  const scenarioId = current()?.operationalScenarios?.at(-1)?.id;
  if (!runId || scenarioBusy) return;
  scenarioBusy = true;
  renderInventory();
  void perform(async () => {
    try {
      if (action === 'inject') {
        if (!injectionRequests.has(runId))
          injectionRequests.set(runId, crypto.randomUUID());
        await api(`runs/${runId}/scenarios`, {
          id: injectionRequests.get(runId),
          kind: 'inventory-mismatch',
        });
        injectionRequests.delete(runId);
        await api(`runs/${runId}/operations/check`, {});
      } else if (action === 'recover') {
        await api(`runs/${runId}/scenarios/${scenarioId}/recover`, {});
      } else {
        await api(`runs/${runId}/operations/check`, {});
      }
    } finally {
      scenarioBusy = false;
      await refresh();
    }
  });
}

$('#inject-inventory').onclick = () => scenarioAction('inject');
$('#recover-inventory').onclick = () => scenarioAction('recover');
$('#check-inventory').onclick = () => scenarioAction('check');

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
  void perform(refresh);
};
$('#provider').onchange = render;
$('#service-health').onchange = (event) =>
  void control({
    action: 'service-health',
    instance: $('#provider').value,
    status: event.target.value,
  });
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
    ...(['stock', 'order', 'return'].includes(data.kind)
      ? { quantity: Number(data.quantity) }
      : {}),
    ...(data.kind === 'refund' ? { outcome: data.outcome } : {}),
    ...(data.kind === 'shipping-method'
      ? { shippingMethodId: data.shippingMethodId }
      : {}),
    ...(data.kind === 'hold' ? { reason: data.reason } : {}),
  };
  void control({ action: 'command', instance: $('#provider').value, command });
};

// Response loss applies only to writes; JTL has two, Shopify one.
function lossOperation(selected) {
  if ($('#provider').value === 'shopify')
    return 'inventory.available.reconcile';

  return selected === 'purchase-orders.submit'
    ? selected
    : 'orders.shipping-method.write';
}

$('#fault [name=kind]').onchange = (event) => {
  const operation = $('#fault [name=operation]');
  const loss = event.target.value === 'response-loss';
  operation.disabled = loss && $('#provider').value === 'shopify';
  if (loss) operation.value = lossOperation(operation.value);
};
$('#fault').onsubmit = (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  const loss = data.kind === 'response-loss';
  void control({
    action: 'fault',
    rule: {
      instance: $('#provider').value,
      operation: loss
        ? lossOperation($('#fault [name=operation]').value)
        : data.operation,
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

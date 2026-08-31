const test = require('node:test');
const assert = require('node:assert/strict');
const { getCurrentLineItems, mapShopifyOrder } = require('../server');

test('uses current quantities and removes fully deleted line items', () => {
  const result = getCurrentLineItems({
    line_items: [
      { name: 'Removed item', quantity: 1, current_quantity: 0 },
      { name: 'Reduced item', quantity: 3, current_quantity: 1 },
      { name: 'Added item', quantity: 1, current_quantity: 2 },
    ],
  });

  assert.deepEqual(
    result.map((item) => [item.name, item.current_quantity]),
    [['Reduced item', 1], ['Added item', 2]],
  );
});

test('falls back to the original quantity for legacy Shopify responses', () => {
  const result = getCurrentLineItems({
    line_items: [{ name: 'Legacy item', quantity: 2 }],
  });

  assert.equal(result[0].current_quantity, 2);
});

test('maps the current line items and current order total for QPX', () => {
  const result = mapShopifyOrder({
    id: 123,
    order_number: 456,
    line_items: [
      { name: 'Deleted item', quantity: 1, current_quantity: 0 },
      { name: 'Current item', quantity: 2, current_quantity: 1 },
    ],
    current_total_price: '125.00',
    total_price: '250.00',
  });

  assert.equal(result.items, 'Current item x1');
  assert.equal(result.total_price, '125.00');
});

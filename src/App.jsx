import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Frame,
  Page,
  Card,
  Layout,
  IndexTable,
  useIndexResourceState,
  Badge,
  Button,
  InlineStack,
  BlockStack,
  Box,
  Text,
  Select,
  TextField,
  Toast,
  Modal,
  Banner,
  Spinner,
  Divider,
  Tooltip,
  Icon,
} from '@shopify/polaris';
import { SettingsIcon } from '@shopify/polaris-icons';

// ─── City / Governorate Matching ─────────────────────────────────────────────

const CITY_MAP = {
  // Cairo
  'cairo': 'قاهره', 'القاهرة': 'قاهره', 'القاهره': 'قاهره', 'القاهر': 'قاهره',
  // Alexandria
  'alexandria': 'اسكندريه', 'الإسكندرية': 'اسكندريه', 'الاسكندريه': 'اسكندريه',
  // Giza (includes 6th of October & Sheikh Zayed)
  'giza': 'جيزة', 'الجيزة': 'جيزة', 'الجيزه': 'جيزة',
  '6th of october': 'جيزة', '6 october': 'جيزة', 'october': 'جيزة',
  'sixth of october': 'جيزة', 'اكتوبر': 'جيزة', 'أكتوبر': 'جيزة',
  // Qalyubia
  'qalyubia': 'قليوبية', 'القليوبية': 'قليوبية',
  // Monufia
  'monufia': 'المنوفية', 'menofia': 'المنوفية', 'المنوفية': 'المنوفية',
  // Beheira
  'beheira': 'البحيرة', 'البحيرة': 'البحيرة',
  // Gharbia
  'gharbia': 'غربيه', 'الغربية': 'غربيه',
  // Sharqia
  'sharqia': 'شرقيه', 'الشرقية': 'شرقيه',
  // Dakahlia
  'dakahlia': 'دقهلية', 'الدقهلية': 'دقهلية',
  // Damietta
  'damietta': 'دمياط', 'دمياط': 'دمياط',
  // Kafr el-Sheikh
  'kafr el sheikh': 'كفر الشيخ', 'kafr el-sheikh': 'كفر الشيخ', 'كفر الشيخ': 'كفر الشيخ',
  // Ismailia
  'ismailia': 'اسماعيلية', 'الإسماعيلية': 'اسماعيلية',
  // Port Said
  'port said': 'بورسعيد', 'بورسعيد': 'بورسعيد',
  // Suez
  'suez': 'سويس', 'السويس': 'سويس',
  // Fayoum
  'fayoum': 'فيوم', 'الفيوم': 'فيوم',
  // Beni Suef
  'beni suef': 'بني سويف', 'بني سويف': 'بني سويف',
  // Minya
  'minya': 'منيا', 'المنيا': 'منيا',
  // Asyut
  'asyut': 'اسيوط', 'assiut': 'اسيوط', 'أسيوط': 'اسيوط',
  // Sohag
  'sohag': 'سوهاج', 'سوهاج': 'سوهاج',
  // Qena
  'qena': 'قنا', 'قنا': 'قنا',
  // Luxor
  'luxor': 'اقصر', 'الأقصر': 'اقصر',
  // Aswan
  'aswan': 'اسوان', 'أسوان': 'اسوان',
  // Red Sea
  'red sea': 'بحر الاحمر', 'البحر الأحمر': 'بحر الاحمر',
  // South Sinai
  'south sinai': 'جنوب سيناء', 'جنوب سيناء': 'جنوب سيناء',
  'sharm el sheikh': 'جنوب سيناء', 'sharm': 'جنوب سيناء',
  // Matrouh
  'matrouh': 'مطروح', 'مطروح': 'مطروح',
  // New Valley
  'new valley': 'وادي جديد', 'الوادي الجديد': 'وادي جديد',
};

function matchCity(province, cities) {
  if (!province || !cities.length) return null;
  const key = province.trim().toLowerCase();
  for (const [alias, qpxName] of Object.entries(CITY_MAP)) {
    if (key === alias || key.includes(alias) || alias.includes(key)) {
      return cities.find((c) => c.name === qpxName) || null;
    }
  }
  return (
    cities.find((c) => {
      const qpx = c.name.toLowerCase().replace(/ه/g, 'ة');
      const k = key.replace(/ه/g, 'ة');
      return qpx.includes(k) || k.includes(qpx);
    }) || null
  );
}

function formatError(raw) {
  try {
    if (raw.includes('<!DOCTYPE') || raw.includes('<html')) return 'خطأ من خادم الشحن';
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'string') return parsed.substring(0, 120);
    return Object.entries(parsed)
      .map(([k, v]) => `${k}: ${Array.isArray(v) ? v[0] : v}`)
      .join(' | ')
      .substring(0, 120);
  } catch {
    return String(raw).substring(0, 120);
  }
}

// ─── Main Component ───────────────────────────────────────────────────────────

const STORE_NAME = window.__STORE_NAME__ || 'My Store';

export default function App() {
  const [orders, setOrders] = useState([]);
  const [cities, setCities] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [statusFilter, setStatusFilter] = useState('any');
  const [limitValue, setLimitValue] = useState('100');
  const [sending, setSending] = useState(false);
  const isSendingRef = useRef(false);
  const [clearingId, setClearingId] = useState(null);
  const [toast, setToast] = useState({ active: false, message: '', error: false });
  const [resultsModal, setResultsModal] = useState({ active: false, results: [] });
  const [settingsModal, setSettingsModal] = useState(false);
  const [settingsForm, setSettingsForm] = useState({ qpxUsername: '', qpxPassword: '', qpxCustomerId: '' });
  const [settingsInfo, setSettingsInfo] = useState(null);
  const [testingConn, setTestingConn] = useState(false);
  const [savingSettings, setSavingSettings] = useState(false);

  const resourceName = { singular: 'أوردر', plural: 'أوردرات' };

  const { selectedResources, allResourcesSelected, handleSelectionChange, clearSelection } =
    useIndexResourceState(orders.map((o) => ({ id: String(o.id) })));

  const sentCount = useMemo(() => orders.filter((o) => o.qpx_serial).length, [orders]);
  const pendingCount = orders.length - sentCount;

  const selectedUnsentOrders = useMemo(
    () => orders.filter((o) => selectedResources.includes(String(o.id)) && !o.qpx_serial),
    [orders, selectedResources]
  );

  // ─── Data Loading ───────────────────────────────────────────────────────────

  // ─── App Bridge Init (signals Shopify mobile "app is ready") ─────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const host = params.get('host');
    const apiKey = window.__SHOPIFY_API_KEY__ || params.get('apiKey');
    if (!host || !apiKey) return;

    const init = () => {
      const AB = window['app-bridge'];
      if (AB && !window.__shopifyApp) {
        window.__shopifyApp = AB.createApp({ apiKey, host, forceRedirect: false });
      }
    };

    if (window['app-bridge']) {
      init();
    } else {
      // CDN script still loading — wait for it
      const script = document.querySelector('script[src*="app-bridge"]');
      if (script) script.addEventListener('load', init);
    }
  }, []);

  // ─── Data Loading ─────────────────────────────────────────────────────────
  useEffect(() => {
    fetch('/api/qpx/cities')
      .then((r) => r.json())
      .then(setCities)
      .catch(console.error);
  }, []);

  const loadOrders = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    clearSelection();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20000);
      const res = await fetch(
        `/api/shopify/orders?status=${statusFilter}&limit=${limitValue}`,
        { signal: controller.signal }
      );
      clearTimeout(timer);
      const data = await res.json();
      if (data.error) throw new Error(JSON.stringify(data.error));
      setOrders(data.orders);
    } catch (e) {
      setLoadError(e.name === 'AbortError' ? 'انتهت مهلة الاتصال، تحقق من الإنترنت' : e.message);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, limitValue]);

  useEffect(() => {
    loadOrders();
  }, [loadOrders]);

  // ─── Send Orders ────────────────────────────────────────────────────────────

  const sendSelected = useCallback(async () => {
    if (isSendingRef.current || !selectedUnsentOrders.length) return;
    isSendingRef.current = true;

    const ordersWithCity = selectedUnsentOrders
      .slice()
      .sort((a, b) => a.shopify_order_number - b.shopify_order_number)
      .map((o) => {
        const cityMatch = matchCity(o.city, cities);
        return { ...o, qpx_city_id: cityMatch ? cityMatch.id : null };
      });

    setSending(true);

    // Split into batches of 50 to avoid 413 payload-too-large errors
    const BATCH_SIZE = 50;
    const batches = [];
    for (let i = 0; i < ordersWithCity.length; i += BATCH_SIZE) {
      batches.push(ordersWithCity.slice(i, i + BATCH_SIZE));
    }

    const allResults = [];
    try {
      for (const batch of batches) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 90000); // 90s per batch
        const res = await fetch('/api/qpx/send-orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ orders: batch }),
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (!res.ok) {
          let errMsg = `Server error: ${res.status}`;
          try { const errData = await res.json(); errMsg = errData.error || errMsg; } catch {}
          throw new Error(errMsg);
        }
        const data = await res.json();
        allResults.push(...data.results);
      }
      setResultsModal({ active: true, results: allResults });
    } catch (e) {
      const msg = e.name === 'AbortError' ? 'انتهت مهلة الإرسال، حاول مرة أخرى' : e.message;
      showToast('❌ ' + msg, true);
      // Show partial results if any were sent before the error
      if (allResults.length > 0) {
        setResultsModal({ active: true, results: allResults });
      }
    } finally {
      isSendingRef.current = false;
      setSending(false);
    }
  }, [selectedUnsentOrders, cities]);

  const closeResultsModal = useCallback(() => {
    setResultsModal({ active: false, results: [] });
    loadOrders();
  }, [loadOrders]);

  const clearQpxSerial = useCallback(async (orderId, orderNumber) => {
    setClearingId(orderId);
    try {
      const res = await fetch(`/api/shopify/orders/${orderId}/qpx-serial`, { method: 'DELETE' });
      if (!res.ok) throw new Error('فشل الطلب');
      setOrders(prev => prev.map(o => o.id === orderId ? { ...o, qpx_serial: null } : o));
      showToast(`✅ تم إلغاء إرسال أوردر #${orderNumber}`);
    } catch (e) {
      showToast('❌ خطأ في إلغاء الإرسال: ' + e.message, true);
    } finally {
      setClearingId(null);
    }
  }, []);

  const openSettings = useCallback(async () => {
    setSettingsModal(true);
    try {
      const res = await fetch('/api/settings');
      const data = await res.json();
      setSettingsInfo(data);
      setSettingsForm({
        qpxUsername: data.qpxUsername || '',
        qpxPassword: '',
        qpxCustomerId: String(data.qpxCustomerId || ''),
      });
    } catch {}
  }, []);

  const saveSettings = useCallback(async () => {
    setSavingSettings(true);
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsForm),
      });
      showToast('✅ تم حفظ الإعدادات');
      setSettingsModal(false);
    } catch (e) {
      showToast('❌ فشل الحفظ: ' + e.message, true);
    } finally {
      setSavingSettings(false);
    }
  }, [settingsForm]);

  const testConnection = useCallback(async () => {
    // Save first then test
    setTestingConn(true);
    try {
      await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settingsForm),
      });
      const res = await fetch('/api/qpx/test-auth');
      const data = await res.json();
      if (data.success) showToast('✅ ' + data.message);
      else showToast('❌ ' + data.error, true);
    } catch (e) {
      showToast('❌ خطأ: ' + e.message, true);
    } finally {
      setTestingConn(false);
    }
  }, [settingsForm]);

  function showToast(message, isError = false) {
    setToast({ active: true, message, error: isError });
  }

  // ─── Table Rows ─────────────────────────────────────────────────────────────

  const rowMarkup = orders.map((order, index) => {
    const isSent = !!order.qpx_serial;
    const cityMatch = matchCity(order.city, cities);

    return (
      <IndexTable.Row
        id={String(order.id)}
        key={order.id}
        selected={selectedResources.includes(String(order.id))}
        position={index}
        disabled={isSent}
        tone={isSent ? 'subdued' : undefined}
      >
        {/* Order # */}
        <IndexTable.Cell>
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            #{order.shopify_order_number}
          </Text>
        </IndexTable.Cell>

        {/* Date */}
        <IndexTable.Cell>
          <Text as="span" variant="bodyMd" tone="subdued">
            {new Date(order.created_at).toLocaleDateString('ar-EG')}
          </Text>
        </IndexTable.Cell>

        {/* Customer */}
        <IndexTable.Cell>
          <Text as="span" variant="bodyMd">{order.customer_name || '—'}</Text>
        </IndexTable.Cell>

        {/* Phone */}
        <IndexTable.Cell>
          <Text as="span" variant="bodyMd">{order.phone || '—'}</Text>
        </IndexTable.Cell>

        {/* Address */}
        <IndexTable.Cell>
          {order.address_full ? (
            <Tooltip content={order.address_full}>
              <Text as="span" variant="bodyMd">
                {order.address_full.length > 35 ? order.address_full.substring(0, 35) + '…' : order.address_full}
              </Text>
            </Tooltip>
          ) : (
            <Text as="span" tone="subdued">—</Text>
          )}
        </IndexTable.Cell>

        {/* Governorate */}
        <IndexTable.Cell>
          <Text as="span" variant="bodyMd">{order.city || '—'}</Text>
        </IndexTable.Cell>

        {/* Items */}
        <IndexTable.Cell>
          <Tooltip content={order.items}>
            <Text as="span" variant="bodyMd" truncate>
              {order.items.length > 40 ? order.items.substring(0, 40) + '…' : order.items}
            </Text>
          </Tooltip>
        </IndexTable.Cell>

        {/* Total */}
        <IndexTable.Cell>
          <Text as="span" variant="bodyMd" fontWeight="semibold">
            {parseFloat(order.total_price).toFixed(0)} {order.currency}
          </Text>
        </IndexTable.Cell>

        {/* QPX Status */}
        <IndexTable.Cell>
          {isSent ? (
            <InlineStack gap="200" blockAlign="center">
              <Badge tone="success">✅ {order.qpx_serial}</Badge>
              <Tooltip content="إلغاء الإرسال (لإعادة الإرسال مرة أخرى)">
                <Button
                  size="micro"
                  tone="critical"
                  variant="plain"
                  loading={clearingId === order.id}
                  onClick={() => clearQpxSerial(order.id, order.shopify_order_number)}
                >
                  ↩
                </Button>
              </Tooltip>
            </InlineStack>
          ) : (
            <Badge tone="attention">⏳ لم يُرسل</Badge>
          )}
        </IndexTable.Cell>
      </IndexTable.Row>
    );
  });

  // ─── Results Modal Content ───────────────────────────────────────────────────

  const successResults = resultsModal.results.filter((r) => r.status === 'success');
  const errorResults = resultsModal.results.filter((r) => r.status === 'error');

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <Frame>
      {/* Toast */}
      {toast.active && (
        <Toast
          content={toast.message}
          error={toast.error}
          onDismiss={() => setToast((t) => ({ ...t, active: false }))}
          duration={5000}
        />
      )}

      <Page
        title="🚚 QPX Express"
        subtitle={`${STORE_NAME} — لوحة الشحن`}
        secondaryActions={[{
          content: 'الإعدادات',
          icon: SettingsIcon,
          onAction: openSettings,
        }]}
      >

        <BlockStack gap="500">

          {/* ── Stats ── */}
          <Layout>
            <Layout.Section variant="oneThird">
              <Card>
                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued">إجمالي الأوردرات</Text>
                  <Text variant="heading2xl" as="p">{loading ? '—' : orders.length}</Text>
                </BlockStack>
              </Card>
            </Layout.Section>
            <Layout.Section variant="oneThird">
              <Card>
                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued">تم الإرسال لـ QPX</Text>
                  <Text variant="heading2xl" as="p" tone="success">{loading ? '—' : sentCount}</Text>
                </BlockStack>
              </Card>
            </Layout.Section>
            <Layout.Section variant="oneThird">
              <Card>
                <BlockStack gap="100">
                  <Text variant="bodySm" tone="subdued">في الانتظار</Text>
                  <Text variant="heading2xl" as="p">{loading ? '—' : pendingCount}</Text>
                </BlockStack>
              </Card>
            </Layout.Section>
          </Layout>

          {/* ── Filters + Actions ── */}
          <Card>
            <InlineStack gap="300" blockAlign="end" wrap>
              <div style={{ minWidth: 200 }}>
                <Select
                  label="حالة الأوردرات"
                  options={[
                    { label: 'كل الأوردرات', value: 'any' },
                    { label: 'مفتوحة فقط', value: 'open' },
                    { label: 'مغلقة / مكتملة', value: 'closed' },
                  ]}
                  value={statusFilter}
                  onChange={setStatusFilter}
                />
              </div>
              <div style={{ width: 100 }}>
                <TextField
                  label="عدد"
                  type="number"
                  value={limitValue}
                  onChange={setLimitValue}
                  min={1}
                  max={600}
                  autoComplete="off"
                />
              </div>
              <Button onClick={loadOrders} loading={loading && orders.length > 0}>
                🔄 تحديث
              </Button>
              {selectedUnsentOrders.length > 0 && (
                <Button
                  variant="primary"
                  onClick={sendSelected}
                  loading={sending}
                  disabled={sending}
                >
                  📦 إرسال للشحن ({selectedUnsentOrders.length})
                </Button>
              )}
            </InlineStack>
          </Card>

          {/* ── Error Banner ── */}
          {loadError && (
            <Banner tone="critical" title="خطأ في تحميل الأوردرات" onDismiss={() => setLoadError(null)}>
              <p>{loadError}</p>
            </Banner>
          )}

          {/* ── Orders Table ── */}
          <Card padding="0">
            {loading && orders.length === 0 ? (
              <Box padding="1600">
                <BlockStack align="center" inlineAlign="center" gap="400">
                  <Spinner size="large" />
                  <Text tone="subdued">جاري تحميل الأوردرات...</Text>
                </BlockStack>
              </Box>
            ) : (
              <IndexTable
                resourceName={resourceName}
                itemCount={orders.length}
                selectedItemsCount={allResourcesSelected ? 'All' : selectedResources.length}
                onSelectionChange={handleSelectionChange}
                headings={[
                  { title: '#' },
                  { title: 'التاريخ' },
                  { title: 'العميل' },
                  { title: 'الهاتف' },
                  { title: 'العنوان' },
                  { title: 'المحافظة' },
                  { title: 'المنتجات' },
                  { title: 'الإجمالي' },
                  { title: 'حالة QPX' },
                ]}
                emptyState={
                  <Box padding="1600">
                    <BlockStack align="center" inlineAlign="center" gap="300">
                      <Text tone="subdued" variant="bodyLg">لا توجد أوردرات</Text>
                    </BlockStack>
                  </Box>
                }
              >
                {rowMarkup}
              </IndexTable>
            )}
          </Card>

        </BlockStack>
      </Page>

      {/* ── Settings Modal ── */}
      <Modal
        open={settingsModal}
        onClose={() => setSettingsModal(false)}
        title="⚙️ إعدادات شركة الشحن (QPX)"
        primaryAction={{ content: 'حفظ', onAction: saveSettings, loading: savingSettings }}
        secondaryActions={[
          { content: 'اختبار الاتصال', onAction: testConnection, loading: testingConn },
          { content: 'إلغاء', onAction: () => setSettingsModal(false) },
        ]}
      >
        <Modal.Section>
          <BlockStack gap="400">
            {settingsInfo && (
              <Banner tone="info">
                <Text variant="bodySm">
                  المتجر: <strong>{settingsInfo.shopifyStore}</strong>
                  {' — '}
                  رقم العميل الحالي: <strong>{settingsInfo.qpxCustomerId}</strong>
                  {' — '}
                  كلمة المرور: <strong>{settingsInfo.hasPassword ? '••••••' : 'غير محددة'}</strong>
                </Text>
              </Banner>
            )}
            <TextField
              label="اسم المستخدم (QPX Username)"
              value={settingsForm.qpxUsername}
              onChange={(v) => setSettingsForm((f) => ({ ...f, qpxUsername: v }))}
              autoComplete="off"
              placeholder="مثال: mystore@qp"
            />
            <TextField
              label="كلمة المرور (QPX Password)"
              type="password"
              value={settingsForm.qpxPassword}
              onChange={(v) => setSettingsForm((f) => ({ ...f, qpxPassword: v }))}
              autoComplete="new-password"
              placeholder={settingsInfo?.hasPassword ? 'اتركها فارغة للإبقاء على الحالية' : 'أدخل كلمة المرور'}
              helpText={settingsInfo?.hasPassword ? 'اتركها فارغة إذا لم تريد تغييرها' : ''}
            />
            <TextField
              label="رقم العميل (Customer ID)"
              type="number"
              value={settingsForm.qpxCustomerId}
              onChange={(v) => setSettingsForm((f) => ({ ...f, qpxCustomerId: v }))}
              autoComplete="off"
              placeholder="مثال: 1021"
            />
          </BlockStack>
        </Modal.Section>
      </Modal>

      {/* ── Results Modal ── */}
      <Modal
        open={resultsModal.active}
        onClose={closeResultsModal}
        title="📋 نتيجة الإرسال"
        primaryAction={{ content: 'حسناً', onAction: closeResultsModal }}
      >
        <Modal.Section>
          <BlockStack gap="300">
            {successResults.length > 0 && (
              <BlockStack gap="200">
                <Text variant="headingSm" tone="success">
                  ✅ تم إرسال {successResults.length} أوردر بنجاح
                </Text>
                {successResults.map((r) => (
                  <InlineStack key={r.shopify_id} align="space-between" blockAlign="center">
                    <Text>أوردر #{r.order_number}</Text>
                    <Badge tone="success">QPX: {r.qpx_serial}</Badge>
                  </InlineStack>
                ))}
              </BlockStack>
            )}

            {successResults.length > 0 && errorResults.length > 0 && <Divider />}

            {errorResults.length > 0 && (
              <BlockStack gap="200">
                <Text variant="headingSm" tone="critical">
                  ❌ فشل {errorResults.length} أوردر
                </Text>
                {errorResults.map((r) => (
                  <InlineStack key={r.shopify_id} align="space-between" blockAlign="center">
                    <Text>أوردر #{r.order_number}</Text>
                    <Badge tone="critical">{formatError(r.error)}</Badge>
                  </InlineStack>
                ))}
              </BlockStack>
            )}
          </BlockStack>
        </Modal.Section>
      </Modal>
    </Frame>
  );
}

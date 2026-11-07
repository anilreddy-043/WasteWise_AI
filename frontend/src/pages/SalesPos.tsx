import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Minus, Plus, Search, ShoppingCart, Trash2, X } from "lucide-react";
import { checkoutSale, listBatches, listInventorySummary, listProducts, listRecommendations } from "../services/business";
import type { CheckoutTransaction, InventoryBatchRecord, InventorySummaryRecord, ProductRecord, RecommendationRecord } from "../services/business";
import ProductImage from "../components/ProductImage";
import CategoryFilterChips from "../components/CategoryFilterChips";
import { formatAppDateTime } from "../services/generalSettings";

type PosProps = { onNotify: (message: string) => void };
type CartItem = { product: ProductRecord; quantity: number; stock: number };
type ReceiptItem = CheckoutTransaction["items"][number] & { product_name: string; unit: string; category: string; image_url?: string | null };
type CompletedSale = Omit<CheckoutTransaction, "items"> & { items: ReceiptItem[] };

function createIdempotencyKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function currency(value: number): string {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 2 }).format(Number.isFinite(value) ? value : 0);
}

export default function SalesPos({ onNotify }: PosProps) {
  const [products, setProducts] = useState<ProductRecord[]>([]);
  const [inventory, setInventory] = useState<InventorySummaryRecord[]>([]);
  const [batches, setBatches] = useState<InventoryBatchRecord[]>([]);
  const [discountRecommendations, setDiscountRecommendations] = useState<RecommendationRecord[]>([]);
  const [discountLoadError, setDiscountLoadError] = useState("");
  const [activeDiscountIndex, setActiveDiscountIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("All Categories");
  const [cart, setCart] = useState<CartItem[]>([]);
  const [discountType, setDiscountType] = useState<"Percentage" | "Amount">("Percentage");
  const [discount, setDiscount] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState("Cash");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [saleTime, setSaleTime] = useState(() => new Date());
  const [checkingOut, setCheckingOut] = useState(false);
  const [checkoutError, setCheckoutError] = useState("");
  const [refreshWarning, setRefreshWarning] = useState("");
  const [completedSale, setCompletedSale] = useState<CompletedSale | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(() => createIdempotencyKey());
  const [checkoutSignature, setCheckoutSignature] = useState("");

  async function refreshPosData() {
    const [productRows, inventoryRows] = await Promise.all([listProducts(), listInventorySummary()]);
    setProducts(productRows);
    setInventory(inventoryRows);
  }

  useEffect(() => {
    let active = true;
    refreshPosData()
      .then(() => undefined)
      .catch((error: unknown) => {
        if (active) setLoadError(error instanceof Error ? error.message : "Could not load POS products.");
      })
      .finally(() => { if (active) setLoading(false); });
    const timer = window.setInterval(() => setSaleTime(new Date()), 30_000);
    return () => { active = false; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    let active = true;
    Promise.all([listRecommendations(), listBatches()])
      .then(([recommendations, batchRows]) => {
        if (!active) return;
        setDiscountRecommendations(recommendations);
        setBatches(batchRows);
        setDiscountLoadError("");
      })
      .catch((error: unknown) => {
        if (active) setDiscountLoadError(error instanceof Error ? error.message : "Could not load discount offers.");
      });
    return () => { active = false; };
  }, []);

  const attemptSignature = JSON.stringify({
    items: cart.map((item) => ({ product_id: item.product.product_id, quantity: item.quantity })),
    discountType,
    discount,
    paymentMethod,
    customerName,
    customerPhone,
  });

  useEffect(() => {
    if (attemptSignature !== checkoutSignature) {
      setCheckoutSignature(attemptSignature);
      setIdempotencyKey((current) => current && checkoutSignature ? createIdempotencyKey() : current);
      setCheckoutError("");
    }
  }, [attemptSignature, checkoutSignature]);

  const stockByProduct = useMemo(() => new Map(inventory.map((item) => [item.product_id, Number(item.quantity)])), [inventory]);
  const discountOffers = useMemo(() => {
    const productsById = new Map(products.map((product) => [product.product_id, product]));
    const batchesById = new Map(batches.map((batch) => [batch.batch_id, batch]));
    const today = new Date().toISOString().slice(0, 10);
    return discountRecommendations.flatMap((recommendation) => {
      const product = productsById.get(recommendation.product_id);
      const batch = recommendation.batch_id === null ? undefined : batchesById.get(recommendation.batch_id);
      const discountPercent = Number(recommendation.discount_percent);
      if (
        recommendation.status !== "approved" ||
        recommendation.recommendation_type !== "discount" ||
        !product ||
        !batch ||
        batch.product_id !== product.product_id ||
        batch.status !== "active" ||
        Number(batch.quantity_remaining) <= 0 ||
        batch.expiry_date < today ||
        !Number.isFinite(discountPercent) ||
        discountPercent <= 0
      ) return [];
      return [{ recommendationId: recommendation.recommendation_id, product, batchCode: batch.batch_code, discountPercent }];
    }).sort((left, right) => right.discountPercent - left.discountPercent);
  }, [batches, discountRecommendations, products]);
  const visibleDiscountIndex = discountOffers.length ? activeDiscountIndex % discountOffers.length : 0;
  const activeDiscount = discountOffers[visibleDiscountIndex];

  useEffect(() => {
    if (discountOffers.length <= 1) return;
    const timer = window.setInterval(() => {
      setActiveDiscountIndex((current) => (current + 1) % discountOffers.length);
    }, 3500);
    return () => window.clearInterval(timer);
  }, [discountOffers.length]);

  const categories = useMemo(() => [...new Set(products.map((item) => item.category).filter(Boolean))].sort(), [products]);
  const filteredProducts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return products.filter((product) =>
      (category === "All Categories" || product.category === category) &&
      (!needle || product.name.toLowerCase().includes(needle) || product.sku.toLowerCase().includes(needle))
    );
  }, [products, query, category]);

  const subtotal = cart.reduce((sum, item) => sum + Number(item.product.price) * item.quantity, 0);
  const safeDiscount = Math.max(0, Number(discount) || 0);
  const discountAmount = discountType === "Percentage"
    ? Math.min(subtotal, subtotal * Math.min(100, safeDiscount) / 100)
    : Math.min(subtotal, safeDiscount);
  const total = Math.max(0, subtotal - discountAmount);
  const itemCount = cart.reduce((sum, item) => sum + item.quantity, 0);

  function addProduct(product: ProductRecord) {
    if (checkingOut) return;
    const stock = stockByProduct.get(product.product_id) ?? 0;
    if (stock <= 0) {
      onNotify(`${product.name} is out of stock.`);
      return;
    }
    setCart((current) => {
      const existing = current.find((item) => item.product.product_id === product.product_id);
      if (existing) {
        if (existing.quantity >= stock) {
          onNotify(`Only ${stock} ${product.unit} available for ${product.name}.`);
          return current;
        }
        return current.map((item) => item.product.product_id === product.product_id ? { ...item, quantity: item.quantity + 1 } : item);
      }
      return [...current, { product, quantity: 1, stock }];
    });
  }

  function changeQuantity(productId: number, difference: number) {
    if (checkingOut) return;
    setCart((current) => current.flatMap((item) => {
      if (item.product.product_id !== productId) return [item];
      const stock = stockByProduct.get(productId) ?? item.stock;
      const quantity = Math.min(stock, item.quantity + difference);
      if (quantity <= 0) return [];
      if (quantity === item.quantity && difference > 0) onNotify(`Only ${stock} ${item.product.unit} available.`);
      return [{ ...item, quantity }];
    }));
  }

  function removeItem(productId: number) {
    if (checkingOut) return;
    setCart((current) => current.filter((item) => item.product.product_id !== productId));
  }

  async function completeSale() {
    if (checkingOut || cart.length === 0) return;
    setCheckingOut(true);
    setCheckoutError("");
    setRefreshWarning("");

    let transaction: CheckoutTransaction;
    try {
      transaction = await checkoutSale({
        items: cart.map((item) => ({ product_id: item.product.product_id, quantity: item.quantity })),
        discount: {
          type: discountType === "Percentage" ? "percentage" : "amount",
          value: discount,
        },
        payment_method: paymentMethod.toLowerCase() as "cash" | "upi" | "card",
        customer_name: customerName.trim() || null,
        customer_phone: customerPhone.trim() || null,
        idempotency_key: idempotencyKey,
      });
    } catch (error) {
      setCheckoutError(error instanceof Error ? error.message : "The sale could not be completed. Your cart was preserved.");
      setCheckingOut(false);
      return;
    }

    const productsById = new Map(cart.map(({ product }) => [product.product_id, product]));
    setCompletedSale({
      ...transaction,
      items: transaction.items.map((item) => {
        const product = productsById.get(item.product_id);
        return {
          ...item,
          product_name: product?.name ?? `Product #${item.product_id}`,
          unit: product?.unit ?? "",
          category: product?.category ?? "",
          image_url: product?.image_url ?? null,
        };
      }),
    });
    setCart([]);
    setCustomerName("");
    setCustomerPhone("");
    setIdempotencyKey(createIdempotencyKey());
    setCheckoutSignature("");
    onNotify(`Sale ${transaction.transaction_number} completed successfully.`);

    try {
      await refreshPosData();
    } catch {
      setRefreshWarning("Sale completed successfully, but inventory could not be refreshed. Please refresh the page.");
    } finally {
      setCheckingOut(false);
    }
  }

  return (
    <>
    <div className="pos-page">
      <section className="pos-banner">
        <div className="pos-banner-copy">
          <span className="pos-eyebrow">SALES MANAGEMENT</span>
          <h1>Sales / POS</h1>
          <p>Sell products, generate bills and automatically update inventory.</p>
        </div>
        <div className="pos-banner-art" aria-hidden="true"><span>🛒</span><i>🌿</i></div>
      </section>

      <section className="pos-discount-hero" aria-label="Current product discounts">
        <div className="pos-discount-hero-heading">
          <span>LIMITED-TIME OFFERS</span>
          <strong>Special discounts</strong>
        </div>
        {discountLoadError ? <p className="pos-discount-state pos-discount-error" role="alert">{discountLoadError}</p> : activeDiscount ? (
          <div className="pos-discount-slide" aria-live="polite" key={activeDiscount.recommendationId}>
            <ProductImage productId={activeDiscount.product.product_id} productName={activeDiscount.product.name} imageUrl={activeDiscount.product.image_url} className="pos-discount-image" />
            <div className="pos-discount-copy">
              <span className="pos-discount-kicker">{activeDiscount.batchCode} · APPROVED OFFER</span>
              <h2>{activeDiscount.product.name}</h2>
              <p>{activeDiscount.product.category}</p>
            </div>
            <div className="pos-discount-pricing">
              <b className="pos-discount-badge">{activeDiscount.discountPercent.toLocaleString("en-IN", { maximumFractionDigits: 2 })}% OFF</b>
              <span className="pos-discount-old-price">{currency(Number(activeDiscount.product.price))}</span>
              <strong>{currency(Number(activeDiscount.product.price) * (1 - activeDiscount.discountPercent / 100))}</strong>
              <small>Eligible batch discount applies at checkout</small>
            </div>
            <button type="button" className="pos-discount-add" disabled={checkingOut || (stockByProduct.get(activeDiscount.product.product_id) ?? 0) <= 0} onClick={() => addProduct(activeDiscount.product)}>
              Add to bill
            </button>
            {discountOffers.length > 1 && <div className="pos-discount-controls" aria-label="Discount offer carousel controls">
              <button type="button" aria-label="Previous discount offer" onClick={() => setActiveDiscountIndex((current) => (current - 1 + discountOffers.length) % discountOffers.length)}>‹</button>
              <span>{visibleDiscountIndex + 1} / {discountOffers.length}</span>
              <button type="button" aria-label="Next discount offer" onClick={() => setActiveDiscountIndex((current) => (current + 1) % discountOffers.length)}>›</button>
            </div>}
          </div>
        ) : <p className="pos-discount-state">{loading ? "Loading available offers…" : "No active product discounts right now."}</p>}
      </section>

      <section className="pos-layout">
        <article className="pos-products-panel">
          <div className="pos-panel-heading">
            <div><span className="pos-panel-icon"><ShoppingCart size={19} /></span><div><h2>Select Products</h2><p>Choose items to add to the current bill</p></div></div>
          </div>
          <div className="pos-filters">
            <label className="pos-search"><Search size={18} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search by product name or SKU" />{query && <button type="button" aria-label="Clear product search" onClick={() => setQuery("")}><X size={15} /></button>}</label>
            <CategoryFilterChips
              categories={categories}
              value={category}
              onChange={setCategory}
              ariaLabel="Filter products by category"
              disabled={checkingOut}
            />
          </div>

          {loading ? <div className="pos-state">Loading products…</div> : loadError ? <div className="pos-state pos-error">{loadError}</div> : filteredProducts.length === 0 ? <div className="pos-state">No products match this search.</div> : (
            <div className="pos-product-grid">
              {filteredProducts.map((product) => {
                const stock = stockByProduct.get(product.product_id) ?? 0;
                return <article className="pos-product-card" key={product.product_id}>
                  <div className="pos-product-image"><ProductImage productId={product.product_id} productName={product.name} imageUrl={product.image_url} className="pos-product-photo" />{stock <= 0 && <b>Out of stock</b>}</div>
                  <div className="pos-product-copy"><h3>{product.name}</h3><small className="pos-product-category">{product.category}</small><small>{product.sku || "SKU not recorded"}</small></div>
                  <div className="pos-stock"><span>{Number(stock).toLocaleString()} {product.unit}</span><span>available</span></div>
                  <div className="pos-product-footer"><strong>{currency(Number(product.price))}</strong><button type="button" disabled={stock <= 0 || checkingOut} onClick={() => addProduct(product)}><Plus size={15} /> Add</button></div>
                </article>;
              })}
            </div>
          )}
        </article>

        <aside className="pos-bill-panel">
          <div className="pos-bill-heading"><div><h2>Current Bill</h2><span>{itemCount} {itemCount === 1 ? "item" : "items"}</span></div><button type="button" disabled={cart.length === 0 || checkingOut} onClick={() => { if (!checkingOut) setCart([]); }}>Clear Cart</button></div>
          <div className="pos-cart">
            {cart.length === 0 ? <div className="pos-empty-cart"><ShoppingCart size={34} /><b>Your bill is empty</b><span>Add products to begin a sale</span></div> : cart.map((item) => (
              <article className="pos-cart-item" key={item.product.product_id}>
                <div className="pos-cart-product"><ProductImage productId={item.product.product_id} productName={item.product.name} imageUrl={item.product.image_url} className="pos-cart-photo" /><div><b>{item.product.name}</b><small>{currency(Number(item.product.price))} / {item.product.unit}</small></div><button type="button" aria-label={`Remove ${item.product.name}`} disabled={checkingOut} onClick={() => removeItem(item.product.product_id)}><Trash2 size={16} /></button></div>
                <div className="pos-cart-controls"><div><button type="button" aria-label={`Decrease ${item.product.name}`} disabled={checkingOut} onClick={() => changeQuantity(item.product.product_id, -1)}><Minus size={14} /></button><strong>{item.quantity}</strong><button type="button" aria-label={`Increase ${item.product.name}`} disabled={checkingOut} onClick={() => changeQuantity(item.product.product_id, 1)}><Plus size={14} /></button></div><b>{currency(Number(item.product.price) * item.quantity)}</b></div>
              </article>
            ))}
          </div>

          <div className="pos-bill-summary">
            <div><span>Subtotal</span><b>{currency(subtotal)}</b></div>
            <div className="pos-discount-row"><span>Discount</span><div><select aria-label="Discount type" disabled={checkingOut} value={discountType} onChange={(event) => { if (!checkingOut) { setDiscountType(event.target.value as "Percentage" | "Amount"); setDiscount(0); } }}><option>Percentage</option><option>Amount</option></select><input aria-label="Discount value" disabled={checkingOut} type="number" min="0" max={discountType === "Percentage" ? 100 : subtotal} step="0.01" value={discount} onChange={(event) => { if (!checkingOut) setDiscount(Math.max(0, Number(event.target.value) || 0)); }}/></div></div>
            <div><span>Discount applied</span><b>- {currency(discountAmount)}</b></div>
            <div className="pos-total"><span>Total Amount</span><b>{currency(total)}</b></div>
          </div>

          <div className="pos-payment">
            <div className="pos-customer-details">
              <label>Customer name <span>(optional)</span><input type="text" maxLength={120} disabled={checkingOut} value={customerName} onChange={(event) => setCustomerName(event.target.value)} placeholder="Enter customer name" /></label>
              <label>Contact number <span>(optional)</span><input type="tel" maxLength={32} disabled={checkingOut} value={customerPhone} onChange={(event) => setCustomerPhone(event.target.value)} placeholder="Enter contact number" /></label>
            </div>
            <label>Payment Method<select disabled={checkingOut} value={paymentMethod} onChange={(event) => { if (!checkingOut) setPaymentMethod(event.target.value); }}><option>Cash</option><option>UPI</option><option>Card</option></select></label>
            <div className="pos-sale-time"><span>Sales date & time</span><b>{formatAppDateTime(saleTime)}</b></div>
            <div className="pos-payable"><span>Total payable</span><strong>{currency(total)}</strong></div>
            {checkoutError && <div className="pos-checkout-error" role="alert">{checkoutError}</div>}
            {refreshWarning && <div className="pos-checkout-warning" role="alert">{refreshWarning}</div>}
            {completedSale && <div className="pos-checkout-success" role="status"><b>Sale completed: {completedSale.transaction_number}</b><span>Subtotal {currency(Number(completedSale.subtotal))} · Discount {currency(Number(completedSale.discount_amount))} · Total {currency(Number(completedSale.total_amount))}</span><span>Payment: {completedSale.payment_method.toUpperCase()}</span><button type="button" className="pos-print-receipt" onClick={() => window.print()}>Print receipt</button></div>}
            <button type="button" className="pos-complete-sale" disabled={cart.length === 0 || checkingOut} onClick={completeSale}><ShoppingCart size={18} /> {checkingOut ? "Processing Sale…" : "Complete Sale"}</button>
          </div>
        </aside>
      </section>
    </div>
    {completedSale && createPortal(
      <section className="pos-receipt-print" aria-label="Printable sale receipt">
        <header>
          <h1>WasteWise AI</h1>
          <p>Sales receipt</p>
        </header>
        <dl>
          <div><dt>Bill number</dt><dd>{completedSale.transaction_number}</dd></div>
          <div><dt>Date</dt><dd>{formatAppDateTime(completedSale.sold_at)}</dd></div>
          <div><dt>Payment</dt><dd>{completedSale.payment_method.toUpperCase()}</dd></div>
          {completedSale.customer_name && <div><dt>Customer</dt><dd>{completedSale.customer_name}</dd></div>}
          {completedSale.customer_phone && <div><dt>Contact</dt><dd>{completedSale.customer_phone}</dd></div>}
        </dl>
        <table>
          <thead><tr><th>Item</th><th>Qty</th><th>Unit price</th><th>Amount</th></tr></thead>
          <tbody>
            {completedSale.items.map((item) => (
              <tr key={item.sale_item_id}>
                <td><span className="pos-receipt-product"><ProductImage productId={item.product_id} productName={item.product_name} imageUrl={item.image_url} className="pos-receipt-photo" />{item.product_name}</span></td>
                <td>{Number(item.quantity).toLocaleString()} {item.unit}</td>
                <td>{currency(Number(item.unit_price))}</td>
                <td>{currency(Number(item.line_total))}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <dl className="pos-receipt-totals">
          <div><dt>Subtotal</dt><dd>{currency(Number(completedSale.subtotal))}</dd></div>
          <div><dt>Discount</dt><dd>-{currency(Number(completedSale.discount_amount))}</dd></div>
          <div><dt>Total</dt><dd>{currency(Number(completedSale.total_amount))}</dd></div>
        </dl>
      </section>,
      document.body,
    )}
    </>
  );
}

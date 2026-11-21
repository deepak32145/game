// Small pieces shared by the lobby, the table and the admin page.

export const CURRENCY = '₹';
export const money = (n) => `${CURRENCY}${Number(n || 0).toLocaleString('en-IN')}`;

export function Avatar({ user, size = 36 }) {
  const style = { width: size, height: size, fontSize: size * 0.45 };
  return user.picture ? (
    <img className="avatar" style={style} src={user.picture} alt="" referrerPolicy="no-referrer" />
  ) : (
    <div className="avatar" style={style}>{(user.name || '?')[0].toUpperCase()}</div>
  );
}

const TXN_LABEL = {
  admin_credit: 'Added by organiser',
  admin_debit: 'Deducted by organiser',
  cash_buyin: 'Cash table buy-in',
  cash_cashout: 'Cash table cash-out',
  sng_buyin: 'Sit & Go entry',
  sng_refund: 'Sit & Go refund',
  sng_prize: 'Sit & Go prize',
  recovered: 'Returned after restart',
};

export function TxnList({ txns, showBy = false }) {
  if (!txns.length) return <p className="muted small">Nothing yet.</p>;
  return (
    <ul className="txns">
      {txns.map((t, i) => (
        <li key={i}>
          <div>
            <div>{TXN_LABEL[t.type] || t.type}</div>
            <div className="muted small">
              {new Date(t.at).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
              {t.note ? ` · ${t.note}` : ''}
              {showBy && t.by ? ` · by ${t.by}` : ''}
            </div>
          </div>
          <div className="txn-amount">
            <b className={t.amount >= 0 ? 'plus' : 'minus'}>{t.amount >= 0 ? '+' : '−'}{money(Math.abs(t.amount))}</b>
            <div className="muted small">{money(t.balanceAfter)}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

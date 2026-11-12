import { useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'motion/react';
import { useNear } from '../lib/near';
import { NavSlotContext } from '../shell/Shell';
import { SPRING_UI } from '../ui/motion';

/** "averyveryverylongname.testnet" -> "averyver…testnet". */
export function shortAccount(accountId: string): string {
  if (accountId.length <= 20) return accountId;
  const dot = accountId.lastIndexOf('.');
  const suffix = dot > 0 ? accountId.slice(dot + 1) : accountId.slice(-6);
  return `${accountId.slice(0, 8)}…${suffix}`;
}

function Button() {
  const { ready, accountId, connect, disconnect } = useNear();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDown(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!accountId) {
    return (
      <button type="button" className="btn btn-sm" onClick={connect} disabled={!ready}>
        Connect wallet
      </button>
    );
  }

  return (
    <div className="wallet" ref={root}>
      <button
        type="button"
        className="btn btn-sm btn-quiet wallet-button"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="dot dot-live" aria-hidden="true" />
        <span className="wallet-name">{shortAccount(accountId)}</span>
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            className="menu"
            initial={{ opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -4 }}
            transition={SPRING_UI}
          >
            <p className="menu-head small muted" title={accountId}>
              {accountId}
            </p>
            <button
              type="button"
              className="menu-item"
              onClick={() => {
                setOpen(false);
                void disconnect();
              }}
            >
              Disconnect
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** The nav's wallet button, portalled into the slot the shell leaves for it. */
export function WalletButton() {
  const slot = useContext(NavSlotContext);
  return slot ? createPortal(<Button />, slot) : null;
}

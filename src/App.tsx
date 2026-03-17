import React, { useState, useEffect, useCallback } from "react";
import { getNip07Signer } from "./lib/nostr";
import { MarmotProvider, useMarmot } from "./marmot/client";
import { TaskStoreProvider } from "./store/task-store";
import { ConnectionStatus } from "./components/ConnectionStatus";
import { GroupManager } from "./components/GroupManager";
import { Board } from "./components/Board";
import type { EventSigner } from "applesauce-core";
import "./App.css";

function AppContent() {
  const [signer, setSigner] = useState<EventSigner | null>(null);
  const [pubkey, setPubkey] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [signerChecked, setSignerChecked] = useState(false);

  useEffect(() => {
    // NIP-07 extensions inject window.nostr asynchronously, so give them a moment
    const timer = setTimeout(() => {
      const s = getNip07Signer();
      if (s) setSigner(s);
      setSignerChecked(true);
    }, 300);
    return () => clearTimeout(timer);
  }, []);

  const handleConnect = useCallback(async () => {
    const s = getNip07Signer();
    if (!s) return;
    setSigner(s);
    try {
      const pk = await s.getPublicKey();
      setPubkey(pk);
    } catch (err) {
      console.error("Failed to get public key:", err);
    }
  }, []);

  // Not yet connected: show connect screen
  if (!pubkey) {
    return (
      <div className="app">
        <header className="topbar">
          <h1 className="app-title">notetastr</h1>
          <ConnectionStatus
            signer={signer}
            pubkey={pubkey}
            onConnect={handleConnect}
          />
        </header>
        <main className="main-area">
          <div className="placeholder">
            {!signerChecked ? (
              <p>Detecting NIP-07 extension...</p>
            ) : !signer ? (
              <>
                <h2>No NIP-07 Extension Detected</h2>
                <p>
                  Install a Nostr signer extension (nos2x, Alby, etc.) to get
                  started.
                </p>
              </>
            ) : (
              <>
                <h2>Welcome to notetastr</h2>
                <p>Click "Connect" to sign in with your Nostr identity.</p>
              </>
            )}
          </div>
        </main>
      </div>
    );
  }

  // Connected: wrap in MarmotProvider
  return (
    <MarmotProvider signer={signer!} pubkey={pubkey}>
      <div className="app">
        <header className="topbar">
          <h1 className="app-title">notetastr</h1>
          <ConnectionStatus
            signer={signer}
            pubkey={pubkey}
            onConnect={handleConnect}
          />
        </header>
        <div className="app-body">
          <aside className="sidebar">
            <GroupManager
              onGroupSelect={setSelectedGroupId}
              selectedGroupId={selectedGroupId}
            />
          </aside>
          <main className="main-area">
            {selectedGroupId ? (
              <TaskStoreProvider groupId={selectedGroupId}>
                <Board currentUserPubkey={pubkey} />
              </TaskStoreProvider>
            ) : (
              <div className="placeholder">
                <h2>Select a Group</h2>
                <p>
                  Pick a group from the sidebar or create a new one to start
                  managing tasks.
                </p>
              </div>
            )}
          </main>
        </div>
      </div>
    </MarmotProvider>
  );
}

export default function App() {
  return <AppContent />;
}

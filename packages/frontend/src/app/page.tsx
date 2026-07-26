'use client';

import { useEffect, useState } from 'react';
import { createPublicClient, http, type Address } from 'viem';
import { robinhoodChainTestnet } from '@/lib/openclaw-node';
import { calcClawScore } from '@/lib/SeekerScore';

export default function Home() {
  const [status, setStatus] = useState<string>('Connecting...');
  const [balance, setBalance] = useState<string>('0');
  const [score, setScore] = useState<number>(0);

  useEffect(() => {
    const client = createPublicClient({
      chain: robinhoodChainTestnet,
      transport: http(process.env.NEXT_PUBLIC_ROBINHOOD_RPC || ''),
    });

    // Replace with your actual contract address after deployment
    const HOSE_ADDRESS = process.env.NEXT_PUBLIC_HOSE_TOKEN as Address || '0x0000000000000000000000000000000000000000';

    client.readContract({
      address: HOSE_ADDRESS,
      abi: [
        { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
      ],
      functionName: 'totalSupply',
    }).then((supply: bigint) => {
      setStatus(`Total Supply: ${supply.toString()}`);
      const mockScore = calcClawScore({ balance: 0n, holdDays: 0, claimCount: 0 });
      setScore(mockScore.cs100);
    }).catch(() => {
      setStatus('Not deployed yet');
    });
  }, []);

  return (
    <main className="min-h-screen bg-black text-white flex flex-col items-center justify-center p-4">
      <h1 className="text-3xl font-mono mb-4">🐺 HoodSeek OS</h1>
      <p className="text-sm text-gray-400 font-mono mb-8">Agentic Operating System on Robinhood Chain</p>
      <div className="bg-zinc-900 p-6 rounded-lg w-full max-w-md">
        <p className="text-xs text-gray-400">System Status</p>
        <p className="font-mono text-green-400">{status}</p>
        <p className="text-xs text-gray-400 mt-4">Seeker Score (demo)</p>
        <p className="font-mono text-green-400">{score.toFixed(1)}</p>
        <p className="text-xs text-gray-400 mt-4">Contract Address</p>
        <p className="font-mono text-[10px] text-gray-400 truncate">{process.env.NEXT_PUBLIC_HOSE_TOKEN || 'Not set'}</p>
        <p className="text-xs text-gray-400 mt-4">God Mode: <kbd className="bg-black px-1 py-0.5 rounded border border-gray-600">Cmd+K</kbd></p>
      </div>
    </main>
  );
}

import { useEffect, useState, useRef, useMemo } from 'react';
import ForceGraph2D, { ForceGraphMethods } from 'react-force-graph-2d';
import type { VaultGraphPayload } from '../../electron/types';

export function VaultGraph() {
    const [graphData, setGraphData] = useState<VaultGraphPayload>({ nodes: [], edges: [] });
    const [windowSize, setWindowSize] = useState({ width: 800, height: 600 });
    const containerRef = useRef<HTMLDivElement>(null);
    const fgRef = useRef<ForceGraphMethods>();

    useEffect(() => {
        // 1. Fetch initial graph
        window.electronAPI.getVaultGraph().then(data => {
            setGraphData(data);
        });

        // 2. Subscribe to live updates
        const unsub = window.electronAPI.onVaultGraphUpdate((data) => {
            setGraphData(data);
        });

        return () => unsub();
    }, []);

    useEffect(() => {
        // Resize observer to keep canvas sized correctly
        if (!containerRef.current) return;
        const observer = new ResizeObserver((entries) => {
            const { width, height } = entries[0].contentRect;
            setWindowSize({ width, height });
        });
        observer.observe(containerRef.current);
        return () => observer.disconnect();
    }, []);

    const dGraph = useMemo(() => {
        return {
            nodes: graphData.nodes.map(n => ({ ...n })),
            links: graphData.edges.map(e => ({ source: e.source, target: e.target }))
        };
    }, [graphData]);

    return (
        <div className="vault-graph-container h-full w-full relative" ref={containerRef}>
            <div className="absolute top-4 left-4 z-10 bg-[rgba(20,20,30,0.8)] px-4 py-2 rounded-lg border border-gray-800 backdrop-blur-md">
                <h3 className="text-sm font-semibold text-gray-300">Vault Knowledge Graph</h3>
                <p className="text-xs text-gray-500">
                    {graphData.nodes.length} Nodes | {graphData.edges.length} Edges
                </p>
            </div>

            {windowSize.width > 0 && (
                <ForceGraph2D
                    ref={fgRef}
                    width={windowSize.width}
                    height={windowSize.height}
                    graphData={dGraph}
                    nodeLabel="title"
                    nodeColor={() => '#00C6FA'} // brand-blue
                    linkColor={() => 'rgba(223,223,223,0.3)'} // brand-gray with alpha
                    backgroundColor="#0D0F10" // app-black
                    nodeRelSize={6}
                    linkWidth={1.5}
                    linkDirectionalParticles={2}
                    linkDirectionalParticleSpeed={0.005}
                    onNodeClick={(node: any) => {
                        // Center camera on node when clicked
                        fgRef.current?.centerAt(node.x, node.y, 1000);
                        fgRef.current?.zoom(8, 2000);
                    }}
                />
            )}
        </div>
    );
}

import {
  assertKnownBusDestination,
  assertNoBusRoutingCycle,
  assertValidMixerBusTopology,
  groupBusTopologyId,
  mixerBusTopology,
} from '@/project/bus-topology';

describe('mixer bus topology', () => {
  it('includes return and group bus routes from their strip state', () => {
    const nodes = mixerBusTopology(
      {
        buses: [
          {
            id: 'fx',
            name: 'FX',
            gainDb: 0,
            strip: {
              gainDb: 0,
              pan: 0,
              inserts: [],
              sends: [{ busId: 'print', levelDb: -6, enabled: true }],
              outputBusId: 'print',
            },
          },
          { id: 'print', name: 'Print', gainDb: 0 },
        ],
      },
      [{ id: 10, mixer: { gainDb: 0, pan: 0, inserts: [], sends: [], outputBusId: 'fx' } }],
    );

    expect(nodes).toEqual([
      {
        id: 'fx',
        outputBusId: 'print',
        sends: [{ busId: 'print', levelDb: -6, enabled: true }],
      },
      { id: 'print' },
      { id: groupBusTopologyId(10), outputBusId: 'fx', sends: [] },
    ]);
  });

  it('rejects unknown and self destinations', () => {
    const known = new Set(['fx']);
    expect(() => assertKnownBusDestination('missing', known)).toThrow(/Unknown mixer bus id/);
    expect(() => assertKnownBusDestination('fx', known, 'fx')).toThrow(/cannot route to itself/);
  });

  it('rejects cycles introduced by an output or send edge', () => {
    const nodes = [{ id: 'a', outputBusId: 'b' }, { id: 'b' }];
    expect(() => assertNoBusRoutingCycle(nodes, 'b', 'a')).toThrow(/routing cycle/);
    expect(() =>
      assertValidMixerBusTopology([
        { id: 'a', outputBusId: 'b' },
        { id: 'b', sends: [{ busId: 'a' }] },
      ]),
    ).toThrow(/routing cycle/);
  });

  it('includes existing bus sidechain edges when checking cycles', () => {
    const nodes = [{ id: 'a', sidechainSources: ['b'] }, { id: 'b' }];
    expect(() => assertNoBusRoutingCycle(nodes, 'a', 'b')).toThrow(/routing cycle/);
    expect(() =>
      assertValidMixerBusTopology([
        { id: 'a', sidechainSources: ['b'] },
        { id: 'b', sidechainSources: ['a'] },
      ]),
    ).toThrow(/routing cycle/);
  });
});

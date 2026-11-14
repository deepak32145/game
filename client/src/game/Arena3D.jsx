import { useEffect, useRef } from 'react';
import { createArena } from './arena.js';

// React wrapper around the three.js scene. Props are read through a ref each frame,
// so re-renders never rebuild the scene.
export default function Arena3D({ animRef, camMode, canAim, aim, onAim, colors, bowlerKind }) {
  const mountRef = useRef(null);
  const propsRef = useRef({});
  propsRef.current = { camMode, canAim, aim, onAim, colors, bowlerKind };

  useEffect(() => {
    const arena = createArena(mountRef.current, () => propsRef.current, animRef);
    return () => arena.dispose();
  }, [animRef]);

  return <div ref={mountRef} className={`arena ${canAim ? 'aiming' : ''}`} />;
}

/**
 * Springs in the two designer parameters (response, damping ratio), mapped to
 * physics: stiffness = (2*pi/response)^2, damping = 2 * ratio * sqrt(stiffness).
 * Everything here is critically damped: nothing in this app is thrown, so
 * nothing overshoots.
 */
export function spring(response: number, dampingRatio = 1) {
  const stiffness = ((2 * Math.PI) / response) ** 2;
  return {
    type: 'spring' as const,
    mass: 1,
    stiffness,
    damping: 2 * dampingRatio * Math.sqrt(stiffness),
  };
}

/** Default for UI that moves or appears. */
export const SPRING_UI = spring(0.35);
/** Content arriving as it scrolls into view. */
export const SPRING_REVEAL = spring(0.6);
/** Number count. Re-targets from the value on screen. */
export const SPRING_COUNT = spring(0.9);

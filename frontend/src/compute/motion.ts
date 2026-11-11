/**
 * Springs in Apple's two designer parameters, mapped to Motion's physics:
 * stiffness = (2*pi/response)^2 and damping = 2 * ratio * sqrt(stiffness).
 */
export function spring(response: number, dampingRatio = 1) {
  const stiffness = (2 * Math.PI / response) ** 2;
  return {
    type: 'spring' as const,
    mass: 1,
    stiffness,
    damping: 2 * dampingRatio * Math.sqrt(stiffness),
  };
}

/** Default: critically damped, no overshoot. */
export const SPRING_UI = spring(0.4);
/** Pressing down has to feel immediate. */
export const SPRING_PRESS = spring(0.18);
/** Coming back from a press: the one place a gesture earns a little bounce. */
export const SPRING_RELEASE = spring(0.42, 0.72);
export const SPRING_REVEAL = spring(0.7);
/** Hero level count. Critically damped; re-targets from the live value. */
export const SPRING_COUNT = spring(1.1);

export const CARD_VARIANTS = {
  rest: { scale: 1, transition: SPRING_RELEASE },
  hover: { scale: 1.012, transition: SPRING_UI },
  press: { scale: 0.975, transition: SPRING_PRESS },
};

export const PHOTO_VARIANTS = {
  rest: { scale: 1, transition: SPRING_UI },
  hover: { scale: 1.05, transition: SPRING_UI },
  press: { scale: 1.02, transition: SPRING_PRESS },
};

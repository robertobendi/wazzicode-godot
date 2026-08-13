export default function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 1024 1024"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="40" y="40" width="944" height="944" rx="224" fill="#11110F" />
      <g
        fill="#FED7AA"
        transform="matrix(2.6666667 0 0 2.6666667 -128 -320)"
      >
        <g>
          <rect x="120" y="216" width="48" height="192" rx="12" />
          <rect x="120" y="360" width="96" height="48" rx="12" />
        </g>
        <g>
          <rect x="312" y="216" width="48" height="192" rx="12" />
          <rect x="264" y="360" width="96" height="48" rx="12" />
        </g>
        <rect x="216" y="216" width="48" height="96" rx="12" />
      </g>
    </svg>
  );
}

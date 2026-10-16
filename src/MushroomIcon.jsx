// A small solid mushroom (cap and stem), echoing the Hyfax logo, for the
// Dig in buttons. Drawn in currentColor so it takes the button's colour,
// and sized like the lucide icons it sits beside.
export default function MushroomIcon({ size = 15, className = "" }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" className={className}>
      <path d="M2.5 11.2C2.5 6.3 6.8 2.5 12 2.5s9.5 3.8 9.5 8.7c0 .9-.7 1.5-1.6 1.5H4.1c-.9 0-1.6-.6-1.6-1.5Z" />
      <path d="M9.4 13.9h5.2l.5 4.6c.4.6 1.3 1.1 2.2 1.3.6.2.5 1.2-.2 1.2H6.9c-.7 0-.8-1-.2-1.2.9-.2 1.8-.7 2.2-1.3l.5-4.6Z" />
    </svg>
  );
}

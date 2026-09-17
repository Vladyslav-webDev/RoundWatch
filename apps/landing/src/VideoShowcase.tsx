import { Icon } from "./graphics";

export default function VideoShowcase() {
  return (
    <section
      id="video-demo"
      className="section launch-video"
      data-reveal
      aria-labelledby="video-demo-title"
    >
      <div className="section-heading">
        <div>
          <p className="eyebrow">
            <span>02</span>
            <span className="eyebrow-slash">/</span>Video demo
          </p>
          <h2 id="video-demo-title">
            Watch RoundWatch
            <br />
            in action.
          </h2>
        </div>
        <p>
          Create the watch, settle once, let the caller exit, and come back to
          verified MainNet evidence.
        </p>
      </div>

      <div className="launch-video-frame" aria-label="Reserved launch video frame">
        <div className="launch-video-grid" aria-hidden="true" />
        <div className="launch-video-placeholder">
          <span className="launch-video-play" aria-hidden="true">
            <Icon name="play" />
          </span>
          <p className="mono">Launch video slot prepared</p>
          <h3>The final demo will be embedded here.</h3>
          <p>
            The page structure, aspect ratio, responsive layout, and media policy
            are ready. The recording can replace this placeholder without moving
            the surrounding content.
          </p>
          <div className="launch-video-sequence mono">
            <span>Create watch</span>
            <span>→</span>
            <span>x402 settlement</span>
            <span>→</span>
            <span>Caller exits</span>
            <span>→</span>
            <span>MainNet match</span>
          </div>
        </div>
      </div>
    </section>
  );
}

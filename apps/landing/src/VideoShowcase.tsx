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
            <span className="eyebrow-slash">/</span>Legacy demo
          </p>
          <h2 id="video-demo-title">
            Watch RoundWatch
            <br />
            in action.
          </h2>
        </div>
        <p>
          This MainNet recording shows the watch lifecycle on an earlier
          release, before the November 2026 x402 SDK update.
        </p>
      </div>

      <div className="launch-video-frame">
        <video
          className="launch-video-media"
          controls
          playsInline
          preload="metadata"
          poster="/demo/roundwatch-demo-poster.jpg"
          aria-label="Legacy RoundWatch demo on Algorand MainNet"
        >
          <source src="/demo/roundwatch-demo.mp4" type="video/mp4" />
          Your browser does not support the video element.
        </video>
      </div>
    </section>
  );
}

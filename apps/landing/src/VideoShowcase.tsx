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

      <div className="launch-video-frame">
        <video
          className="launch-video-media"
          controls
          playsInline
          preload="metadata"
          poster="/demo/roundwatch-demo-poster.jpg"
          aria-label="RoundWatch production demo on Algorand MainNet"
        >
          <source src="/demo/roundwatch-demo.mp4" type="video/mp4" />
          Your browser does not support the video element.
        </video>
      </div>
    </section>
  );
}

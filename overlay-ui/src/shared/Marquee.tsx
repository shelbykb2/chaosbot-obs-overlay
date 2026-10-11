import { useLayoutEffect, useRef, useState } from 'preact/hooks';

/**
 * One line of text. If it does not fit it scrolls (a CSS animation, so the compositor runs it)
 * with soft faded edges; under reduced motion it ends in an ellipsis instead. It measures once
 * per text, not per frame. `running` pauses the scroll.
 */
export function Marquee(props: { text: string; class: string; reduced: boolean; running: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const first = useRef<HTMLSpanElement>(null);
  const [scroll, setScroll] = useState<{ dist: number } | null>(null);
  const [over, setOver] = useState(false);

  useLayoutEffect(() => {
    setScroll(null);
    const b = box.current, f = first.current;
    if (!b || !f) return;
    const overflow = f.offsetWidth > b.clientWidth + 1;
    setOver(overflow);
    if (overflow && !props.reduced) setScroll({ dist: f.offsetWidth + 56 });
  }, [props.text, props.reduced]);

  const cls =
    props.class + ' mq' + (scroll ? ' is-scroll' : '') + (over && !scroll ? ' is-ellipsis' : '') + (props.running ? '' : ' is-held');
  const style = scroll ? { '--mq-dist': scroll.dist + 'px', '--mq-dur': (2.6 + scroll.dist / 44).toFixed(2) + 's' } : undefined;
  return (
    <div class={cls} ref={box} title={props.text} style={style}>
      <div class="mq-run">
        <span ref={first}>{props.text}</span>
        {scroll && <span aria-hidden="true">{props.text}</span>}
      </div>
    </div>
  );
}

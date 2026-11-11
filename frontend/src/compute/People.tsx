import { motion } from 'motion/react';
import { PEOPLE, PEOPLE_DISCLAIMER, type PersonSpec } from './content';
import { CARD_VARIANTS, PHOTO_VARIANTS } from './motion';
import { Reveal, SectionHead } from './Reveal';

function Person({ person }: { person: PersonSpec }) {
  return (
    <motion.figure
      className="cx-person"
      variants={CARD_VARIANTS}
      initial="rest"
      animate="rest"
      whileHover="hover"
      whileTap="press"
      tabIndex={-1}
    >
      <div className="cx-person-photo">
        <div
          className="cx-person-crop"
          style={person.zoom ? { transform: `scale(${person.zoom.scale})`, transformOrigin: person.zoom.origin } : undefined}
        >
          <motion.img
            variants={PHOTO_VARIANTS}
            src={`/img/compute/${person.slug}.jpg`}
            width={person.width}
            height={person.height}
            alt={`Portrait of ${person.name}`}
            loading="lazy"
            style={{ objectPosition: person.objectPosition }}
          />
        </div>
      </div>
      <figcaption>
        <b>{person.name}</b>
        <span>{person.company}</span>
        <p>{person.line}</p>
      </figcaption>
    </motion.figure>
  );
}

export function People() {
  return (
    <section id="people" className="cx-section">
      <div className="cx-wrap">
        <SectionHead eyebrow="The market" title="The people setting the price of compute." />
        <Reveal>
          <div className="cx-people">
            {PEOPLE.map((person) => <Person key={person.slug} person={person} />)}
          </div>
          <p className="cx-disclaimer">{PEOPLE_DISCLAIMER}</p>
        </Reveal>
      </div>
    </section>
  );
}

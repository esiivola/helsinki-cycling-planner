from __future__ import annotations

from build_search import names_of, notability, poi_kind


def test_a_destination_is_classified_by_what_it_is() -> None:
    assert poi_kind({"tourism": "museum"}) == "attraction"
    assert poi_kind({"shop": "mall"}) == "mall"
    assert poi_kind({"shop": "bakery"}) == "shop"
    assert poi_kind({"leisure": "park"}) == "park"
    # An island is tagged `place`, not `natural`; without this Korkeasaari is not a
    # destination at all and only a ferry berth elsewhere answers to the name.
    assert poi_kind({"place": "island"}) == "nature"


def test_a_thing_that_is_not_a_destination_is_not_indexed() -> None:
    # Indexing everything with a name buries the places worth riding to.
    assert poi_kind({"highway": "residential", "name": "Mannerheimintie"}) is None
    assert poi_kind({"barrier": "gate"}) is None


def test_every_name_a_rider_might_type_is_indexed() -> None:
    # Oodi is officially "Helsingin keskustakirjasto Oodi"; nobody types that.
    names = names_of({"name": "Helsingin keskustakirjasto Oodi", "short_name": "Oodi", "name:sv": "Ode"})

    assert names == ["Helsingin keskustakirjasto Oodi", "Oodi", "Ode"]
    assert names_of({"name": "Kamppi", "alt_name": "Kampin keskus;Kamppi Center"})[1:] == [
        "Kampin keskus", "Kamppi Center",
    ]


def test_wikipedias_own_title_orders_two_places_of_one_name() -> None:
    # Both Korkeasaaris carry a wikidata tag, so notability alone cannot separate
    # them; the parenthetical in the article title is what says which is which.
    helsinki = {"name": "Korkeasaari", "wikidata": "Q54824182", "wikipedia": "fi:Korkeasaari"}
    espoo = {"name": "Korkeasaari", "wikidata": "Q49648648", "wikipedia": "fi:Korkeasaari (Espoo)"}

    assert notability(helsinki) > notability(espoo) > notability({"name": "Korkeasaari"})

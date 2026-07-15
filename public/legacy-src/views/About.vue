<template>
    <main class="main-content">
        <div class="about">
            <p>Lorem ipsum dolor sit amet consectetur adipisicing elit. Autem animi voluptas tempora eius? Possimus perspiciatis a ut unde debitis aliquam vel sunt consequatur nemo? Alias numquam quaerat vitae veniam rerum!</p>
            Counter value is: <label v-model="test.counter">{{test.counter}}</label>, press this to increase: 
            <btn-counter></btn-counter>
            <br><br>
            <h6>Todos({{doneTodosCount}}): </h6>
            <ul>
                <li v-for="(todo, index) in test.todos" @click="doneTodo(todo.id)" :style="{textDecoration: todo.status ? 'line-through' : ''}">{{todo.title}}</li>
            </ul>
            <label>{{ user.fname }}</label>
        </div>
    </main>
</template>
<script>
import {mapState, mapGetters, mapMutations, mapActions} from 'vuex'
import BtnCounter from '../components/BtnCounter';
export default {
    computed: {
        ...mapState(['test', 'user']),
        ...mapGetters(['doneTodos', 'doneTodosCount'])
    },
    methods: {
        ...mapMutations(['doneTodo']),
        // ...mapActions({
        //     doneTodo: "done"
        // })
    },
    components: {
        'btn-counter': BtnCounter
    }
}
</script>
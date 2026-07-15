<template>
    <div class="form-wrapper">

		<div class="logo">
			<img src="assets/media/image/logo-sm.png" width="64" alt="image">
		</div>

		<h5>ورود مدیران</h5>

		<!-- form -->
		<form @submit.prevent="onSubmit">
			<div class="form-group">
				<input type="text" class="form-control" name="username" v-model="formData.username" placeholder="نام کاربری" required autofocus>
			</div>
			<div class="form-group">
				<input type="password" class="form-control" name="password" v-model="formData.password" placeholder="رمز عبور" required>
			</div>
			<div class="form-group d-flex justify-content-between">
				<div class="custom-control custom-checkbox">
					<input type="checkbox" class="custom-control-input" checked="" id="customCheck1">
					<label class="custom-control-label" for="customCheck1">مرا به خاطر بسپار</label>
				</div>
				<a href="recover-password.html">فراموشی رمز عبور</a>
			</div>
			<button class="btn btn-primary btn-block">ورود کاربران</button>
        </form>
        <!-- ./ form -->
    </div>
</template>
<script>
import axios from 'axios';
import { log } from 'util';

export default {
	data(){
		return {
			formData: {
				username: "",
				password: ""
			}
		}
	},
	methods: {
		async onSubmit(){
			let loginResponse = await axios.post("login", this.formData);
			if( loginResponse && loginResponse.data.ok ){
				toastr['success'](`${loginResponse.data.userData.fname} عزیز، خوش آمدی...`);
				this.$store.state.user = loginResponse.data.userData;
				// localStorage.setItem('user', JSON.stringify(this.$store.state.user));
				sessionStorage.setItem('user', JSON.stringify(this.$store.state.user));
				this.$store.state.showPanel = true;
                if( localStorage.getItem('night-mode') ) document.querySelector("body").classList.add('dark');
                document.getElementsByTagName("body")[0].classList.remove("form-membership");
				this.$router.push('/');
			}else{
				toastr['error']("نام کاربری یا رمز عبور اشتباه است.");
				this.formData.username = "";
				this.formData.password = "";
			}
		}
	},
    mounted(){
		if( this.$store.state.showPanelFlag ){
			this.$store.state.showPanelFlag = false;
			this.$store.state.showPanel = false;
            document.getElementsByTagName("body")[0].classList.remove("dark");
            document.getElementsByTagName("body")[0].classList.add("form-membership");
		}
	}
}
</script>